import { type BadgeStatus, type ScrobbleReply, onMessage, sendMessage } from "@/messaging";
import {
  type ParsedMedia,
  type Recipe,
  extract,
  isManualRecipe,
  readField,
  selectRecipe,
} from "@tmsync/shared";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { ScrobbleController } from "./controller";

const RECONCILE_DEBOUNCE_MS = 600;
const PROGRESS_PERSIST_MS = 5000;
const TAB_MEDIA_POLL_MS = 750;
const TAB_MEDIA_POLL_TRIES = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mediaKey(m: ParsedMedia): string {
  return `${m.mediaType}:${m.title}:${m.season ?? ""}:${m.episode ?? ""}`;
}

function label(m: ParsedMedia): string {
  const ep = m.season !== undefined ? ` S${m.season}E${m.episode ?? "?"}` : "";
  const yr = m.year ? ` (${m.year})` : "";
  return `${m.title}${ep}${yr}`;
}

/** Title as Trakt matched it, keeping the scraped season/episode (transparency). */
function resolvedLabel(title: string, year: number | undefined, m: ParsedMedia): string {
  const ep = m.season !== undefined ? ` S${m.season}E${m.episode ?? "?"}` : "";
  return `${title}${year ? ` (${year})` : ""}${ep}`;
}

function statusFromReply(
  action: "start" | "pause" | "stop",
  reply: ScrobbleReply,
  m: ParsedMedia,
): BadgeStatus {
  // Prefer what Trakt actually matched (transparency); keep the scraped S/E.
  const title = reply.resolvedTitle
    ? resolvedLabel(reply.resolvedTitle, reply.resolvedYear, m)
    : label(m);
  if (reply.ok) {
    if (action === "start") return { state: "watching", title };
    if (action === "pause") return { state: "paused", title };
    return reply.action === "scrobble"
      ? { state: "scrobbled", title, detail: "added to history" }
      : { state: "stopped", title };
  }
  const detail =
    reply.reason === "not_connected"
      ? "connect Trakt"
      : reply.reason === "unresolved"
        ? "not found on Trakt"
        : reply.reason === "no_episode"
          ? "missing episode #"
          : `scrobble failed${reply.status ? ` (${reply.status})` : ""}${
              reply.httpError ? `: ${reply.httpError.slice(0, 80)}` : ""
            }`;
  return { state: "error", title, detail };
}

/** Patch history once per frame so SPA navigations emit a window event. */
let historyPatched = false;
function ensureLocationChangeEvents(): void {
  if (historyPatched) return;
  historyPatched = true;
  const fire = () => window.dispatchEvent(new Event("tmsync:locationchange"));
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function patched(this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      fire();
      return result;
    } as History[typeof method];
  }
  window.addEventListener("popstate", fire);
}

/**
 * Per-frame watch-session manager. Handles the three roles a frame can play:
 *  - matcher: this frame matches a recipe → extract + publish media for the tab
 *    (so a cross-origin player iframe can consume it) and seed the badge.
 *  - player: this frame owns the <video> → resolve media (its own or pulled from
 *    the tab) and drive the scrobble state machine.
 *  - both (no iframe): the common case.
 * Re-reconciles on SPA navigation and on the video loading new media.
 */
type PlayerFrame = "auto" | "top" | "iframe";

export class SessionManager {
  private localMedia: ParsedMedia | null = null;
  private videoSelector = "video";
  private frame: PlayerFrame = "auto";
  private watchedThreshold = 0.8;
  private lastPublishedKey: string | null = null;
  /** Manual recipe matched but no selection yet — wait for the user's pick. */
  private manualAwaiting = false;
  /** Show page matched but its URL carries no episode — wait for the user to
   * supply season/episode via the badge (e.g. a "?play=true" deep link). */
  private episodeAwaiting = false;
  /** URL an episode override was last applied for. Cleared (and the override
   * dropped) when we navigate away, so returning to an S/E-less URL re-prompts. */
  private episodeOverrideUrl: string | null = null;
  private framesObserver: MutationObserver | null = null;
  private readonly seenFrameOrigins = new Set<string>();
  private currentKey: string | null = null;
  private currentVideo: HTMLVideoElement | null = null;
  private controller: ScrobbleController | null = null;
  private abort: AbortController | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private videoObserver: MutationObserver | null = null;

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly recipes: Recipe[],
  ) {}

  private get isTop(): boolean {
    return window === window.top;
  }

  start(): void {
    ensureLocationChangeEvents();
    window.addEventListener("tmsync:locationchange", this.scheduleReconcile, {
      signal: this.frameSignal(),
    });
    this.ctx.onInvalidated(() => this.teardownSession());

    // SPA sites often set the real title/og:title AFTER initial load (e.g. cineby
    // shows the site name first). Re-extract when <head> metadata changes.
    if (document.head) {
      const headObserver = new MutationObserver(this.scheduleReconcile);
      headObserver.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["content"],
      });
      this.ctx.onInvalidated(() => headObserver.disconnect());
    }

    // A correction was saved → drop the current (wrong) session and re-resolve.
    const offRecheck = onMessage("recheck", () => {
      this.lastPublishedKey = null;
      this.teardownSession();
      void this.reconcile();
    });
    this.ctx.onInvalidated(() => offRecheck());

    // Any video starting to play is a strong signal to (re-)evaluate — catches a
    // player that reuses the trailer's element or appears only after Play.
    window.addEventListener("play", () => void this.ensurePlaying(), {
      capture: true,
      signal: this.frameSignal(),
    });

    void this.reconcile();
    if (this.isTop) this.watchPlayerFrames();
  }

  /** AbortSignal tied to the content-script lifetime (frame-level listeners). */
  private frameSignal(): AbortSignal {
    const ac = new AbortController();
    this.ctx.onInvalidated(() => ac.abort());
    return ac.signal;
  }

  private scheduleReconcile = (): void => {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => void this.reconcile(), RECONCILE_DEBOUNCE_MS);
  };

  private async reconcile(): Promise<void> {
    await this.matchAndPublish();
    // Awaiting the user: a manual-site title pick, or the episode # for an
    // S/E-less show URL. Nothing to play until they choose.
    if (this.manualAwaiting || this.episodeAwaiting) return;
    await this.ensurePlaying();
  }

  /** If this frame matches a recipe, extract + publish the media and seed the badge. */
  private async matchAndPublish(): Promise<void> {
    const engineCtx = { document, url: location.href };

    // Navigated away from the URL an episode override was set for: drop it so a
    // later return to that (ambiguous) URL re-prompts instead of reusing a stale
    // episode it may no longer be playing.
    if (this.episodeOverrideUrl && this.episodeOverrideUrl !== location.href) {
      void sendMessage("clearEpisodeOverride", { url: this.episodeOverrideUrl });
      this.episodeOverrideUrl = null;
    }

    const recipe = selectRecipe(this.recipes, engineCtx);
    if (!recipe) {
      this.localMedia = null;
      this.manualAwaiting = false;
      this.episodeAwaiting = false;
      if (this.isTop) await sendMessage("publishManualContext", null);
      return;
    }

    // Manual recipe: nothing to scrape. The top frame derives the page key,
    // looks up a remembered pick, and otherwise prompts the user via the badge.
    if (isManualRecipe(recipe)) {
      this.episodeAwaiting = false;
      if (this.isTop) await this.handleManual(recipe, engineCtx);
      else this.localMedia = null; // a player iframe consumes the published media
      return;
    }

    this.manualAwaiting = false;
    const result = extract(recipe, engineCtx);
    if (!result.ok) {
      this.localMedia = null;
      return;
    }
    let media = result.media;

    // A show whose URL carries no episode (e.g. a Cineby "?play=true" deep link):
    // the page can't tell us which episode is playing. Apply a season/episode the
    // user supplied for this URL, else prompt for it via the badge — without one
    // the scrobble would fail with "missing episode #".
    if (media.mediaType === "show" && media.episode === undefined) {
      const override = await sendMessage("getEpisodeOverride", undefined);
      if (override) {
        media = { ...media, season: override.season, episode: override.episode };
        this.episodeOverrideUrl = location.href;
      } else {
        // Enter the prompt. Only the first time (not on the recheck-driven
        // re-reconcile below) do we stop the tab session — otherwise the still-
        // playing player iframe keeps reporting the previous episode and the
        // prompt never sticks. The guard also prevents a recheck → reconcile loop.
        if (!this.episodeAwaiting) {
          this.episodeAwaiting = true;
          await sendMessage("stopTabSession", undefined);
        }
        this.localMedia = null;
        this.lastPublishedKey = null;
        this.teardownSession();
        await sendMessage("reportScrobble", {
          state: "idle",
          title: label(media),
          detail: "set the episode to scrobble",
          needEpisode: true,
        });
        return;
      }
    }

    this.episodeAwaiting = false;
    this.localMedia = media;
    this.videoSelector = recipe.video.selector;
    this.frame = recipe.video.frame;
    this.watchedThreshold = recipe.video.watchedThreshold;

    // Avoid churn from the head observer firing on unrelated mutations.
    const key = mediaKey(media);
    if (key === this.lastPublishedKey) return;
    this.lastPublishedKey = key;

    await sendMessage("publishMedia", {
      media,
      videoSelector: recipe.video.selector,
      frame: recipe.video.frame,
      watchedThreshold: recipe.video.watchedThreshold,
    });

    // Seed the badge immediately with the scraped title, then refine it with what
    // Trakt actually matched — so the user can verify (and fix) the target BEFORE
    // pressing play, not only after the first scrobble fires.
    await sendMessage("reportScrobble", { state: "idle", title: label(media) });
    const resolved = await sendMessage("resolveMedia", media);
    await sendMessage(
      "reportScrobble",
      resolved.resolved && resolved.title
        ? {
            state: "idle",
            title: resolvedLabel(resolved.title, resolved.year, media),
            detail: "press play to scrobble",
          }
        : {
            state: "error",
            title: label(media),
            detail: "not found on Trakt — click to fix",
          },
    );
  }

  /**
   * Manual recipe (top frame). There's nothing to scrape, so derive a stable
   * page key (the recipe's manualKey value, else the page title), publish the
   * manual context for the badge, and look up a remembered pick. If one exists,
   * drive it exactly like a scraped match; otherwise prompt the user to pick.
   */
  private async handleManual(
    recipe: Recipe,
    engineCtx: { document: Document; url: string },
  ): Promise<void> {
    this.videoSelector = recipe.video.selector;
    this.frame = recipe.video.frame;
    this.watchedThreshold = recipe.video.watchedThreshold;

    const pageKey =
      (recipe.manualKey ? readField(recipe.manualKey, engineCtx) : null) ?? document.title.trim();
    await sendMessage("publishManualContext", { recipeId: recipe.id, pageKey });

    const media = await sendMessage("getManualMedia", { recipeId: recipe.id, pageKey });
    if (!media) {
      // No selection for what's playing — stop any stale session and prompt.
      this.manualAwaiting = true;
      this.localMedia = null;
      this.lastPublishedKey = null;
      this.teardownSession();
      await sendMessage("reportScrobble", {
        state: "idle",
        detail: "Pick what you’re watching",
        pick: true,
      });
      return;
    }

    this.manualAwaiting = false;
    this.localMedia = media;
    const key = `manual:${pageKey}:${mediaKey(media)}`;
    if (key === this.lastPublishedKey) return;
    this.lastPublishedKey = key;

    await sendMessage("publishMedia", {
      media,
      videoSelector: this.videoSelector,
      frame: this.frame,
      watchedThreshold: this.watchedThreshold,
    });
    // The pick is locked to a Trakt entry via a correction, so resolveMedia hits;
    // either way the title is set, so seed the badge and let play scrobble it.
    const resolved = await sendMessage("resolveMedia", media);
    await sendMessage("reportScrobble", {
      state: "idle",
      title:
        resolved.resolved && resolved.title
          ? resolvedLabel(resolved.title, resolved.year, media)
          : label(media),
      detail: "press play to scrobble",
    });
  }

  /**
   * The first <video> that isn't a muted, looping background trailer (common on
   * movie landing pages). Falls back to any video if all look like trailers.
   */
  private findVideo(): HTMLVideoElement | null {
    const seen = new Set<HTMLVideoElement>();
    const candidates: HTMLVideoElement[] = [];
    for (const sel of [this.videoSelector, "video"]) {
      for (const v of document.querySelectorAll<HTMLVideoElement>(sel)) {
        if (!seen.has(v)) {
          seen.add(v);
          candidates.push(v);
        }
      }
    }
    // Exclude muted, looping background trailers entirely (never fall back to
    // one — that would scrobble just from viewing a movie landing page). Prefer
    // a video that's actually playing.
    const real = candidates.filter((v) => !(v.loop && v.muted));
    return real.find((v) => !v.paused) ?? real[0] ?? null;
  }

  private async pullTabMedia(): Promise<{ media: ParsedMedia; frame: PlayerFrame } | null> {
    for (let i = 0; i < TAB_MEDIA_POLL_TRIES; i++) {
      const tab = await sendMessage("getTabMedia", undefined);
      if (tab) {
        this.videoSelector = tab.videoSelector;
        this.watchedThreshold = tab.watchedThreshold;
        return { media: tab.media, frame: tab.frame };
      }
      await sleep(TAB_MEDIA_POLL_MS);
    }
    return null;
  }

  /**
   * Find the video and start a session for the resolved media (its own or the
   * tab's). The play decision is trailer-skip (findVideo) + one-owner-per-tab
   * dedup in the background — a wrong "iframe"/"top" guess no longer blocks it.
   */
  private async ensurePlaying(): Promise<void> {
    let media = this.localMedia;
    if (!media) {
      const tab = await this.pullTabMedia();
      if (!tab) return;
      media = tab.media;
    }

    const video = this.findVideo();
    if (!video) {
      this.observeForVideo();
      return;
    }

    const key = mediaKey(media);
    if (this.abort && key === this.currentKey && this.currentVideo === video) return; // already running

    this.startSession(video, media);
  }

  /**
   * Top-frame only: watch for cross-origin player iframes. Two jobs:
   *  - Always accumulate every cross-origin iframe origin seen (debounced, only
   *    when new) so the popup can offer late-loading player frames to enable.
   *  - When the recipe says the player is in an iframe and none is enabled yet,
   *    push an actionable badge hint (main feedback channel where no console).
   */
  private watchPlayerFrames(): void {
    const scan = async () => {
      const origins = this.crossOriginIframeOrigins();
      if (origins.length === 0) return;

      const fresh = origins.filter((o) => !this.seenFrameOrigins.has(o));
      if (fresh.length > 0) {
        for (const o of fresh) this.seenFrameOrigins.add(o);
        void sendMessage("reportFrameOrigins", origins);
      }

      // Only hint when the recipe expects an iframe player — avoids false hints
      // from ad/analytics iframes on ordinary sites.
      if (this.frame !== "iframe") return;
      const enabled = new Set(await sendMessage("listEnabledSites", undefined));
      // If any cross-origin frame is already enabled, the player is set up — the
      // rest are almost certainly ads; stay quiet.
      if (origins.some((o) => enabled.has(o))) return;
      await sendMessage("reportScrobble", {
        state: "error",
        title: this.localMedia ? label(this.localMedia) : undefined,
        detail: `enable player frame in TMSync popup: ${origins.join(", ")}`,
      });
    };
    void scan();
    // Debounce: the subtree observer fires constantly on busy SPAs; we only need
    // to re-scan iframes occasionally.
    let timer: ReturnType<typeof setTimeout> | null = null;
    this.framesObserver = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void scan();
      }, 500);
    });
    this.framesObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.ctx.onInvalidated(() => this.framesObserver?.disconnect());
  }

  private crossOriginIframeOrigins(): string[] {
    const set = new Set<string>();
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        const u = new URL((frame as HTMLIFrameElement).src, location.href);
        if ((u.protocol === "http:" || u.protocol === "https:") && u.origin !== location.origin) {
          set.add(u.origin);
        }
      } catch {
        // empty/relative/unparseable src — skip
      }
    }
    return [...set];
  }

  private observeForVideo(): void {
    if (this.videoObserver) return;
    this.videoObserver = new MutationObserver(() => {
      if (this.findVideo()) {
        this.videoObserver?.disconnect();
        this.videoObserver = null;
        void this.ensurePlaying();
      }
    });
    this.videoObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.ctx.onInvalidated(() => this.videoObserver?.disconnect());
  }

  private startSession(video: HTMLVideoElement, media: ParsedMedia): void {
    this.teardownSession();

    const abort = new AbortController();
    this.abort = abort;
    this.currentVideo = video;
    this.currentKey = mediaKey(media);

    const controller = new ScrobbleController(
      video,
      (action, progress) => {
        void sendMessage("scrobble", { action, media, progress }).then((reply) => {
          // We still tell Trakt to stop the outgoing episode — but if we've since
          // shown the episode prompt (tearing down e.g. S1E2 to ask which episode
          // a "?play=true" URL is on), this stop's late reply must not overwrite
          // the prompt back to the old episode.
          if (action === "stop" && this.episodeAwaiting) return;
          void sendMessage("reportScrobble", statusFromReply(action, reply, media));
        });
        if (action === "stop") void sendMessage("endSession");
        else void sendMessage("updateProgress", progress);
      },
      this.watchedThreshold,
    );
    this.controller = controller;

    const on = (target: EventTarget, type: string, fn: () => void) =>
      target.addEventListener(type, fn, { signal: abort.signal });

    on(video, "play", () => controller.play());
    on(video, "pause", () => controller.pause());
    on(video, "ended", () => controller.ended());
    // New media loaded into the same element (SPA episode swap) → reconcile.
    on(video, "loadstart", this.scheduleReconcile);
    on(window, "pagehide", () => controller.leave());

    let lastPersist = 0;
    on(video, "timeupdate", () => {
      // Commit to history the moment playback crosses the threshold — no pause
      // or `ended` required. Cheap + idempotent (one stop per session).
      controller.progressTick();
      const now = Date.now();
      if (now - lastPersist < PROGRESS_PERSIST_MS) return;
      lastPersist = now;
      void sendMessage("updateProgress", controller.progress());
    });

    // If playback is already underway when we attach (late injection), kick a start.
    if (!video.paused && !video.ended) controller.play();
  }

  private teardownSession(): void {
    // Emit a stop for the outgoing session (SPA episode swap, nav away) before
    // dropping its listeners. ScrobbleController.leave() is idempotent.
    this.controller?.leave();
    this.controller = null;
    if (this.abort) {
      this.abort.abort(); // remove this session's listeners
      this.abort = null;
    }
    this.currentVideo = null;
    this.currentKey = null;
  }
}
