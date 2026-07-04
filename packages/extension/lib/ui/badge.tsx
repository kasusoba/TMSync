import "@/lib/ui/theme.css";
import { type BadgePrefs, badgePrefs } from "@/lib/storage";
import type { Tracker } from "@/lib/tracker/types";
import { type BadgeState, type BadgeStatus, onMessage, sendMessage } from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
import clsx from "clsx";
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { useKeyShield } from "./key-shield";
import { Btn, Icon, IconBtn, tokens } from "./proto/kit";
import {
  AniListCorrection,
  Correction,
  EpisodePick,
  ManualPick,
  RateNote,
  RatingRow,
} from "./scrobble-panels";
import { keepAboveModals } from "./top-layer";

const t = tokens("dark");

/** Default anchor when the user hasn't dragged it (position === null). */
const DEFAULT_CORNER = "bottom-3.5 left-3.5";
const EDGE_GAP = "14px"; // distance from the docked edge

type XY = { x: number; y: number };

/** Identity of the item being rated — mirrors mediaKey() in session.ts. Lets the
 * badge tell a real episode change (SPA nav) from a same-episode status update,
 * so refreshing `media` only swaps the object when the episode actually changed. */
function mediaIdentity(m: ParsedMedia | null): string {
  if (!m) return "";
  const id = m.tmdbId !== undefined ? `tmdb${m.tmdbId}` : m.title;
  return `${m.mediaType}:${id}:${m.season ?? ""}:${m.episode ?? ""}`;
}
type Edge = "left" | "right" | "top" | "bottom";
type EdgePos = { edge: Edge; offset: number };

/** Nearest screen edge to a drop point, plus the offset (0–1) ALONG that edge. */
function snapToEdge(x: number, y: number): EdgePos {
  const d = { left: x, right: window.innerWidth - x, top: y, bottom: window.innerHeight - y };
  const edge = (Object.keys(d) as Edge[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
  const frac = (n: number, total: number) => Math.min(1, Math.max(0, n / total));
  const offset =
    edge === "left" || edge === "right" ? frac(y, window.innerHeight) : frac(x, window.innerWidth);
  return { edge, offset };
}

/** Within this fraction of an edge's end, dock flush into the corner. */
const CORNER_ZONE = 0.08;

/**
 * Inline style for a docked position — computed PURELY in render (no setState),
 * so it can never feed a re-render loop. The cross-axis is corner-flush at the
 * extremes (so all four corners are reachable), and a % along the edge otherwise
 * — anchored toward screen-centre so a tall expanded panel stays on-screen.
 */
function edgeStyle(p: EdgePos): Record<string, string> {
  const off = Math.min(1, Math.max(0, p.offset));
  const G = EDGE_GAP;
  const edgeAnchor: Record<string, string> =
    p.edge === "left"
      ? { left: G }
      : p.edge === "right"
        ? { right: G }
        : p.edge === "top"
          ? { top: G }
          : { bottom: G };
  const horizontal = p.edge === "top" || p.edge === "bottom"; // cross-axis is x
  let cross: Record<string, string>;
  if (off < CORNER_ZONE) cross = horizontal ? { left: G } : { top: G };
  else if (off > 1 - CORNER_ZONE) cross = horizontal ? { right: G } : { bottom: G };
  else {
    const start = `${(off * 100).toFixed(2)}%`;
    const end = `${((1 - off) * 100).toFixed(2)}%`;
    const nearStart = off < 0.5;
    cross = horizontal
      ? nearStart
        ? { left: start }
        : { right: end }
      : nearStart
        ? { top: start }
        : { bottom: end };
  }
  return { ...edgeAnchor, ...cross };
}

const STATE: Record<BadgeState, { color: string; glow: string; label: string }> = {
  idle: {
    color: "bg-zinc-400",
    glow: "shadow-[0_0_7px_2px_rgba(161,161,170,0.4)]",
    label: "matched",
  },
  watching: {
    color: "bg-emerald-500",
    glow: "shadow-[0_0_8px_2px_rgba(16,185,129,0.55)]",
    label: "scrobbling",
  },
  paused: {
    color: "bg-amber-500",
    glow: "shadow-[0_0_8px_2px_rgba(245,158,11,0.55)]",
    label: "paused",
  },
  scrobbled: {
    color: "bg-sky-500",
    glow: "shadow-[0_0_8px_2px_rgba(56,189,248,0.55)]",
    label: "added to history",
  },
  stopped: {
    color: "bg-zinc-500",
    glow: "shadow-[0_0_7px_2px_rgba(113,113,122,0.4)]",
    label: "stopped",
  },
  error: {
    color: "bg-rose-500",
    glow: "shadow-[0_0_8px_2px_rgba(244,63,94,0.55)]",
    label: "error",
  },
};

/** How long the rating prompt stays up after a scrobble before auto-collapsing. */
const AUTO_COLLAPSE_MS = 12_000;

function BadgeRoot() {
  const [status, setStatus] = useState<BadgeStatus | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [panel, setPanel] = useState<
    null | "review" | "fix" | "anilist-fix" | "manual" | "episode"
  >(null);
  const [media, setMedia] = useState<ParsedMedia | null>(null);
  const [tracker, setTracker] = useState<Tracker>("trakt");
  /** The item's enabled trackers (multi-track) — the rate/note composer fans out
   * across these; `tracker` stays the primary for the quick prompt. */
  const [trackers, setTrackers] = useState<Tracker[]>(["trakt"]);
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [rewatchHidden, setRewatchHidden] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  // Hide the badge while the page is in native fullscreen (player gone immersive) —
  // an overlay over fullscreen video is intrusive. Tracked separately from prefs so
  // it auto-restores on exit. In the top frame, a fullscreen iframe player still
  // reports as `document.fullscreenElement`, so this covers cross-origin players too.
  const [fullscreen, setFullscreen] = useState(false);
  // User pref: whether the in-page badge shows + its dragged position (the toolbar
  // icon is always the ambient indicator). Live-updated so changes apply at once.
  const [prefs, setPrefs] = useState<BadgePrefs>({ mode: "full", position: null });
  // Docked position (edge + offset); null = default corner. Seeded from prefs.
  const [pos, setPos] = useState<EdgePos | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragged = useRef(false); // suppress the click that follows a drag
  // FLIP: the badge's on-screen rect at drop time, so the layout effect can glide
  // it from where you let go to the snapped edge.
  const flipFrom = useRef<DOMRect | null>(null);

  useEffect(() => {
    void badgePrefs.getValue().then((v) => {
      setPrefs(v);
      setPos(v.position);
    });
    return badgePrefs.watch((v) => {
      if (!v) return;
      setPrefs(v);
      setPos(v.position);
    });
  }, []);

  // "Dot" mode keeps the badge collapsed to its status dot by default.
  useEffect(() => {
    if (prefs.mode === "dot") setMinimized(true);
  }, [prefs.mode]);

  // Glide to the snapped edge (FLIP): after the new docked position renders,
  // invert to where the badge was let go, then spring to the new spot. No
  // setState here — pure DOM, so it can't loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: animate when pos changes
  useLayoutEffect(() => {
    const el = rootRef.current;
    const from = flipFrom.current;
    flipFrom.current = null;
    if (!el || !from) return;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (!dx && !dy) return;
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      if (!rootRef.current) return;
      rootRef.current.style.transition = "transform 380ms cubic-bezier(0.34, 1.32, 0.5, 1)";
      rootRef.current.style.transform = "";
    });
  }, [pos]);

  // Drag the badge by a handle (the dot, or the panel's status bar). We write the
  // transform straight to the DOM during the move (no re-render → buttery), then
  // snap to the nearest edge on release and let the FLIP effect animate it.
  const startDrag = (e: PointerEvent) => {
    if (e.button !== 0 || !rootRef.current) return;
    const el = rootRef.current;
    let moved = false;
    let dx = 0;
    let dy = 0;
    let pointer: XY = { x: e.clientX, y: e.clientY };
    el.style.transition = "none";
    el.style.willChange = "transform";
    const onMove = (ev: PointerEvent) => {
      dx = ev.clientX - e.clientX;
      dy = ev.clientY - e.clientY;
      if (!moved && Math.hypot(dx, dy) > 4) moved = true;
      if (moved) {
        el.style.transform = `translate(${dx}px, ${dy}px) scale(1.06)`; // a little "lift"
        pointer = { x: ev.clientX, y: ev.clientY };
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      el.style.willChange = "";
      if (!moved) {
        el.style.transform = "";
        return;
      }
      dragged.current = true;
      const snapped = snapToEdge(pointer.x, pointer.y); // snap to where you point
      // Drop the scale "lift" but keep the translate, so the FLIP starts exactly
      // where the dot/panel visually is (not its slightly-larger scaled box).
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      flipFrom.current = el.getBoundingClientRect();
      el.style.transform = ""; // back to the base position; FLIP glides from `from`
      setPos(snapped);
      void badgePrefs.setValue({ ...prefs, position: snapped });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // True (and resets) if the just-finished pointer interaction was a drag — so the
  // synthetic click after a drag doesn't also expand/minimize.
  const consumeDrag = () => {
    if (!dragged.current) return false;
    dragged.current = false;
    return true;
  };

  useEffect(() => {
    const off = onMessage("scrobbleStatus", ({ data }) => {
      if (data.hide) {
        // SPA navigated away from a scrobblable page — drop the badge and reset
        // per-session UI so the next match starts clean.
        setStatus(null);
        setPanel(null);
        setMedia(null);
        setMinimized(false);
        setPromptDismissed(false);
        return;
      }
      setStatus(data);
      setRewatchHidden(false); // a fresh status may carry a new rewatch prompt
    });
    return () => off();
  }, []);

  // Pull the tab's media + tracker whenever the status changes (needed for
  // rating/note/fix). An SPA episode change publishes a new item AND a fresh
  // status, so re-fetching here keeps the rate/note panel on the CURRENT episode
  // — the panels key off `media`, so without this they stay on the previous one.
  // Only swap the object when the episode identity actually changed, so a
  // same-episode status update (play/pause) never clobbers a note being typed.
  useEffect(() => {
    if (!status) return;
    void sendMessage("getTabMedia", undefined).then((tab) => {
      if (!tab) return;
      setTracker(tab.tracker);
      setTrackers(tab.trackers ?? [tab.tracker]);
      setMedia((prev) => (mediaIdentity(prev) === mediaIdentity(tab.media) ? prev : tab.media));
    });
  }, [status]);

  // Track native fullscreen so we can get out of the way while a video is fullscreen.
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement !== null);
    sync();
    document.addEventListener("fullscreenchange", sync, true);
    return () => document.removeEventListener("fullscreenchange", sync, true);
  }, []);

  // Keep keys typed in the badge (rating/note/search) from firing page & other-
  // extension shortcuts — see useKeyShield.
  useKeyShield(rootRef);

  // Track whether this is a manual-mode site, so "wrong match?" re-opens the
  // manual picker (changing the remembered pick) rather than the correction UI.
  useEffect(() => {
    if (status) void sendMessage("getManualContext", undefined).then((c) => setManualMode(!!c));
  }, [status]);

  // After a watch lands in history, leave the rating prompt up for a moment then
  // auto-collapse to the dot so it gets out of the way.
  useEffect(() => {
    if (status?.state === "scrobbled" && panel === null && !minimized) {
      const id = setTimeout(() => setMinimized(true), AUTO_COLLAPSE_MS);
      return () => clearTimeout(id);
    }
  }, [status?.state, panel, minimized]);

  if (!status) return null;
  if (prefs.mode === "off") return null; // hidden — rely on the toolbar icon + popup
  if (fullscreen) return null; // stay out of the way of fullscreen video

  const s = STATE[status.state];
  // Docked: edge style. Otherwise the default corner. (During a drag the transform
  // is written straight to the DOM, so the base position stays put under it.)
  const posStyle = pos ? edgeStyle(pos) : undefined;
  const anchor = pos ? "" : DEFAULT_CORNER;
  const summary = `TMSync · ${status.detail ?? s.label}${status.title ? ` — ${status.title}` : ""}`;

  // Minimized: a status dot with a soft glow. The dot is also the drag handle.
  if (minimized) {
    return (
      <div ref={rootRef} class={clsx("fixed z-[2147483646] font-sans", anchor)} style={posStyle}>
        <button
          type="button"
          class="grid cursor-grab touch-none place-items-center p-1.5 active:cursor-grabbing"
          onPointerDown={startDrag}
          onClick={() => {
            if (consumeDrag()) return;
            setMinimized(false);
          }}
          title={`${summary} — drag to move`}
          aria-label={summary}
        >
          <span class={clsx("tmsync-dot size-3.5 rounded-full", s.color, s.glow)} />
        </button>
      </div>
    );
  }

  // Rating prompt: Trakt on any scrobble; AniList only when the cour completed.
  const showPrompt =
    status.state === "scrobbled" &&
    media !== null &&
    panel === null &&
    !promptDismissed &&
    (tracker !== "anilist" || status.completed === true);

  const confirmRewatch = () => {
    if (!media) return;
    setRewatchHidden(true); // background pushes the resulting status back
    void sendMessage("confirmRewatch", { media });
  };

  return (
    <div
      ref={rootRef}
      class={clsx(
        "tmsync-pop fixed z-[2147483646] flex max-w-[340px] flex-col gap-2 font-sans",
        anchor,
      )}
      style={posStyle}
      // Any panel title ([data-tmsync-drag]) drags the whole popup, like the badge
      // status bar — so you can reposition an expanded panel by its header.
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest?.("[data-tmsync-drag]")) startDrag(e);
      }}
    >
      {panel === "review" && media && (
        <RateNote
          media={media}
          trackers={trackers}
          t={t}
          onClose={() => setPanel(null)}
          onFix={() => setPanel(manualMode ? "manual" : "fix")}
          onFixAniList={() => setPanel("anilist-fix")}
        />
      )}
      {panel === "fix" && <Correction t={t} onClose={() => setPanel(null)} />}
      {panel === "anilist-fix" && <AniListCorrection t={t} onClose={() => setPanel(null)} />}
      {panel === "manual" && (
        <ManualPick t={t} onClose={() => setPanel(null)} onDone={() => setPanel(null)} />
      )}
      {panel === "episode" && (
        <EpisodePick
          title={status.title}
          t={t}
          onClose={() => setPanel(null)}
          onDone={() => setPanel(null)}
        />
      )}

      {status.pick && panel === null && (
        <div
          class={clsx(
            "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
            t.panel,
          )}
        >
          <span class={clsx("whitespace-nowrap text-[12px] font-semibold", t.heading)}>
            What are you watching?
          </span>
          <Btn t={t} tone="primary" class="ml-auto" onClick={() => setPanel("manual")}>
            Pick title
          </Btn>
        </div>
      )}

      {status.needEpisode && panel === null && (
        <div
          class={clsx(
            "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
            t.panel,
          )}
        >
          <span class={clsx("whitespace-nowrap text-[12px] font-semibold", t.heading)}>
            Which episode?
          </span>
          <Btn t={t} tone="primary" class="ml-auto" onClick={() => setPanel("episode")}>
            Set episode
          </Btn>
        </div>
      )}

      {status.rewatch && panel === null && !rewatchHidden && (
        <div
          class={clsx(
            "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
            t.panel,
          )}
        >
          <span class="min-w-0">
            <span class={clsx("block whitespace-nowrap text-[12px] font-semibold", t.heading)}>
              Rewatching?
            </span>
            {status.title && (
              <span class={clsx("block max-w-[200px] truncate text-[11px]", t.sub)}>
                {status.title} · completed before
              </span>
            )}
          </span>
          <Btn t={t} tone="primary" class="ml-auto" onClick={confirmRewatch}>
            Start rewatch
          </Btn>
          <IconBtn t={t} name="x" title="Dismiss" onClick={() => setRewatchHidden(true)} />
        </div>
      )}

      {showPrompt && media && (
        <div
          class={clsx(
            "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
            t.panel,
          )}
        >
          <span class={clsx("whitespace-nowrap text-[12px] font-semibold", t.heading)}>
            {tracker === "anilist"
              ? "Rate this cour?"
              : `Rate ${media.season !== undefined ? "episode" : "movie"}?`}
          </span>
          <div class="flex-1">
            <RatingRow
              media={media}
              tracker={tracker}
              t={t}
              level={
                tracker === "anilist" ? "cour" : media.season !== undefined ? "episode" : "movie"
              }
              compact
            />
          </div>
          <button
            type="button"
            onClick={() => setPanel("review")}
            class={clsx(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
              t.ghost,
            )}
          >
            <Icon name="edit" class="text-[11px]" />
            Note
          </button>
          <IconBtn t={t} name="x" title="Dismiss" onClick={() => setPromptDismissed(true)} />
        </div>
      )}

      {/* The status bar doubles as the drag handle (drag to reposition). */}
      <div
        class={clsx(
          "inline-flex cursor-grab touch-none items-center gap-2.5 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30 active:cursor-grabbing",
          t.panel,
        )}
        onPointerDown={startDrag}
      >
        <span class={clsx("size-2.5 shrink-0 rounded-full", s.color)} />
        <button
          type="button"
          class="min-w-0 flex-1 cursor-pointer text-left"
          onClick={() => {
            if (consumeDrag()) return;
            setPanel((p) =>
              p ? null : status.pick ? "manual" : status.needEpisode ? "episode" : "review",
            );
          }}
          title={
            status.pick
              ? "Pick what you’re watching"
              : status.needEpisode
                ? "Set the episode you’re watching"
                : "Rate, note, or fix the match · drag the bar to move"
          }
        >
          <span class={clsx("block text-[12px] font-semibold", t.heading)}>
            TMSync · {status.detail ?? s.label}
          </span>
          {status.title && (
            <span class={clsx("block truncate text-[12px]", t.sub)}>{status.title}</span>
          )}
        </button>
        <IconBtn
          t={t}
          name="minimize"
          title="Minimize to a dot"
          onClick={() => {
            if (consumeDrag()) return;
            setMinimized(true);
          }}
        />
        <IconBtn
          t={t}
          name="eye-off"
          title="Hide the on-page badge (turn it back on from the toolbar popup)"
          onClick={() => {
            if (consumeDrag()) return;
            void badgePrefs.setValue({ ...prefs, mode: "off" });
          }}
        />
      </div>
    </div>
  );
}

export async function mountBadge(ctx: ContentScriptContext): Promise<void> {
  // Keep the badge above site modals: sites that play inside a <dialog>.showModal()
  // (browser top layer) would otherwise bury it behind the player AND make it
  // inert. keepAboveModals re-parents our host into the active modal so the badge
  // stays visible and clickable, moving it back to <body> when the modal closes.
  let dropTopLayer = () => {};
  const ui = await createShadowRootUi(ctx, {
    name: "tmsync-badge",
    position: "overlay",
    anchor: "body",
    onMount: (container, _shadow, host) => {
      render(<BadgeRoot />, container);
      dropTopLayer = keepAboveModals(host);
    },
    onRemove: (container) => {
      dropTopLayer();
      container && render(null, container);
    },
  });
  ui.mount();
}
