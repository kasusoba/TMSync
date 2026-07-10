import { RECIPES } from "@/config";
import { confirmAniListRewatch, resolveAniListById } from "@/lib/anilist/adapter";
import {
  connect as anilistConnect,
  disconnect as anilistDisconnect,
  isConnected as anilistIsConnected,
  getRedirectUri as anilistRedirectUri,
} from "@/lib/anilist/auth";
import {
  AniListNotConnectedError,
  anilistCacheKey,
  resolve as anilistResolve,
  searchAniList,
  viewerScoreFormat,
} from "@/lib/anilist/client";
import { ANILIST } from "@/lib/anilist/config";
import {
  anilistDeleteNote,
  anilistGetReview,
  anilistRate,
  anilistSaveNote,
  anilistUnrate,
} from "@/lib/anilist/review";
import { type AnimapOverrides, deriveMediaWith, forwardKey } from "@/lib/animap/derive";
import { bundledLinks } from "@/lib/recipes";
import { statusDotColor } from "@/lib/scrobble/action-badge";
import {
  type QuickLinkSite,
  anilistCorrections,
  anilistResolutionCache,
  animapOverrides,
  corrections,
  customRecipes,
  enabledOrigins,
  episodeOverrides,
  manualContexts,
  manualSelections,
  quickLinks,
  remoteRecipes,
  resolutionCache,
  tabFrameOrigins,
  tabSessions,
  tabStatus,
} from "@/lib/storage";
import { getAdapter, inferNativeTracker, routeTracker } from "@/lib/tracker";
import type { TrackedItem, Tracker } from "@/lib/tracker/types";
import { connect, disconnect, getRedirectUri, isConnected } from "@/lib/trakt/auth";
import { TraktNotConnectedError, exportLetterboxd, resolve, search } from "@/lib/trakt/client";
import {
  traktDeleteNote,
  traktGetReview,
  traktRate,
  traktSaveNote,
  traktUnrate,
} from "@/lib/trakt/review";
import type { ReviewLevel } from "@/lib/trakt/types";
import { resolutionCacheKey } from "@/lib/trakt/util";
import {
  type BadgeStatus,
  type DerivedOutcome,
  type ScrobbleReply,
  type ScrobbleRequest,
  type TrackerResolution,
  onMessage,
  sendMessage,
} from "@/messaging";
import { type LibraryLink, type ParsedMedia, type Recipe, parseLibrary } from "@tmsync/shared";
import { browser } from "wxt/browser";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const siteId = (origin: string) => `tmsync-${origin.replace(/[^a-z0-9]/gi, "-")}`;

/**
 * MV3 service worker. STATELESS (constraint #4): every handler reads from
 * storage; no session state, timers, or buffers held here.
 */
const OWNER_TTL_MS = 5 * 60 * 1000;

export default defineBackground(() => {
  // Dynamic content-script registrations are cleared on extension reload/update
  // (not browser restart). Re-establish them from the enabled-origins list so a
  // plain "reload the extension" is enough and survives updates.
  void reconcileRegistrations();

  // Seed quick links shipped in the bundled library (available offline, before
  // the first fetch), then refresh the CDN list on startup + a periodic alarm
  // (the SW is ephemeral, so we can't hold a timer — constraint #4).
  void mergeLibraryLinks(bundledLinks);
  void fetchRemoteRecipes();
  browser.alarms.create("tmsync-recipes", { periodInMinutes: 720 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "tmsync-recipes") void fetchRemoteRecipes(true);
  });

  onMessage("refreshRecipes", async () => {
    const out = await fetchRemoteRecipes(true);
    return out;
  });

  onMessage("ping", () => "pong" as const);

  onMessage("getTraktStatus", async () => ({
    connected: await isConnected(),
    redirectUri: getRedirectUri(),
  }));

  onMessage("connectTrakt", async () => {
    try {
      await connect();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  onMessage("disconnectTrakt", () => disconnect());

  onMessage("getAniListStatus", async () => ({
    connected: await anilistIsConnected(),
    redirectUri: anilistRedirectUri(),
    configured: !!(ANILIST.clientId && ANILIST.clientSecret),
  }));

  onMessage("connectAniList", async () => {
    try {
      await anilistConnect();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  onMessage("disconnectAniList", () => anilistDisconnect());

  onMessage("exportLetterboxd", async () => {
    try {
      const { csv, count } = await exportLetterboxd();
      return { ok: true, csv, count };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof TraktNotConnectedError ? "Not connected to Trakt" : errMsg(e),
      };
    }
  });

  // A frame reports a video event; route to the recipe's tracker adapter, resolve
  // identity (cached) and record progress. The Trakt and AniList paradigms differ
  // entirely (real-time scrobble vs one threshold write) — that lives behind the
  // adapter; this handler is tracker-agnostic.
  onMessage("scrobble", async ({ data, sender }) => {
    // Only one frame records per tab (page + player iframe would otherwise both
    // fire start/pause/stop for the same item → Trakt rejects out-of-order).
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    if (tabId !== undefined && !(await claimScrobbleOwner(tabId, frameId, data.action))) {
      return { ok: true, resolved: true }; // another frame owns this tab's scrobble
    }
    // MULTI-TRACK: the enabled set + which tracker speaks the page's numbering
    // natively (recorded directly). Every OTHER enabled tracker is derived via the
    // crosswalk. `trackers` is authoritative; fall back to the legacy single field.
    const enabled = data.trackers?.length ? data.trackers : [data.tracker ?? "trakt"];
    // Native must be an ENABLED tracker (a disabled one can't be recorded directly).
    // So an AniList-only recipe on a TMDB/seasoned site records AniList directly with
    // the scraped episode instead of forcing it through the crosswalk.
    const native = inferNativeTracker(data.media, enabled);
    const nativeEnabled = enabled.includes(native);
    // Resolve the native item when we'll record it, OR to BRIDGE a reverse (→Trakt)
    // derive (which needs the AniList id). Forward (→AniList) uses the scraped
    // tmdbId, so it needs no native item.
    const needNative = nativeEnabled || (native === "anilist" && enabled.includes("trakt"));
    let nativeItem: TrackedItem | null = null;
    let nativeThrew = false;
    if (needNative) {
      try {
        nativeItem = await getAdapter(native).resolve(data.media);
      } catch {
        nativeThrew = true;
      }
    }

    // Record the native tracker directly — only if the user enabled it.
    let nativeReply: ScrobbleReply | null = null;
    if (nativeEnabled) {
      if (nativeThrew) {
        nativeReply = { ok: false, resolved: false, reason: "http", primaryTracker: native };
      } else if (!nativeItem) {
        nativeReply = { ok: false, resolved: false, reason: "unresolved", primaryTracker: native };
      } else {
        const result = await getAdapter(native).recordProgress(
          nativeItem,
          data.media,
          data.progress,
          data.action,
          data.watchedThreshold ?? 0.8,
        );
        nativeReply = {
          ok: result.ok,
          status: result.status,
          action: result.action,
          resolved: true,
          reason: result.ok ? undefined : result.reason,
          completed: result.completed,
          info: result.info,
          atEpisode: result.atEpisode,
          resolvedTitle: result.reason === "no_episode" ? undefined : nativeItem.title,
          resolvedYear: result.reason === "no_episode" ? undefined : nativeItem.year,
          resolvedEpisodes: nativeItem.tracker === "anilist" ? nativeItem.episodes : undefined,
          httpError: result.httpError,
          primaryTracker: native,
        };
      }
    }

    // Derive + record every OTHER enabled tracker via the crosswalk (+ overrides).
    // When the native tracker isn't enabled there's no anchor to bridge from, so
    // those trackers resolve themselves on a miss (id → title) instead of skipping.
    const derived = await recordDerivedTrackers(
      nativeItem,
      enabled.filter((t) => t !== native),
      data,
      await animapOverrides.getValue(),
      !nativeEnabled,
    );

    // Native is the badge's primary when enabled; otherwise promote the first
    // derived tracker so a derive-only recipe (e.g. AniList-only on a TMDB site)
    // still drives the badge.
    if (nativeReply) return { ...nativeReply, derived: derived.length ? derived : undefined };
    const [head, ...rest] = derived;
    if (!head) return { ok: false, resolved: false, reason: "unresolved" };
    return { ...derivedToReply(head), derived: rest.length ? rest : undefined };
  });

  // Pre-resolution for the badge: resolve identity (cached) without recording so
  // the user sees the matched tracker title before play. Reads work
  // unauthenticated for both trackers, so transparency holds even pre-connect.
  onMessage("resolveMedia", async ({ data }) => {
    try {
      const adapter = getAdapter(routeTracker(data.tracker ?? "trakt", data.media.mediaType));
      const item = await adapter.resolve(data.media);
      if (!item) return { resolved: false };
      return {
        resolved: true,
        id: item.id,
        title: item.title,
        year: item.year,
        mediaType: item.mediaType,
      };
    } catch {
      return { resolved: false };
    }
  });

  // MULTI-TRACK: per-tracker destination readout for the rate/correction UI.
  onMessage("resolveAll", async ({ data }) => {
    const trackers = data.trackers?.length ? data.trackers : (["trakt"] as Tracker[]);
    try {
      return await resolveAcross(data.media, trackers, await animapOverrides.getValue());
    } catch {
      return trackers.map((tracker) => ({ tracker, resolved: false, reason: "http" }));
    }
  });

  onMessage("registerSite", ({ data }) => registerSite(data));
  onMessage("unregisterSite", ({ data }) => unregisterSite(data));
  onMessage("listEnabledSites", () => enabledOrigins.getValue());

  // --- manual mode (sites with no readable title) ---
  onMessage("getManualMedia", async ({ data }) => {
    const all = await manualSelections.getValue();
    return all[`${data.recipeId}::${data.pageKey}`] ?? null;
  });

  onMessage("setManualMedia", async ({ data, sender }) => {
    // Lock resolution to the exact entry the user picked via a correction — so
    // re-searching the title can't drift to a remake/wrong year later.
    const key = resolutionCacheKey(data.media);
    const corr = await corrections.getValue();
    corr[key] = data.identity;
    await corrections.setValue(corr);
    const cache = await resolutionCache.getValue();
    if (cache[key]) {
      delete cache[key];
      await resolutionCache.setValue(cache);
    }
    // Remember the pick so the same file/title auto-resolves next time.
    const all = await manualSelections.getValue();
    all[`${data.recipeId}::${data.pageKey}`] = data.media;
    await manualSelections.setValue(all);
    // Re-resolve the tab so the session picks up the chosen media and scrobbles.
    const tabId = data.tabId ?? sender.tab?.id;
    if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
    return { ok: true };
  });

  onMessage("getEpisodeOverride", async ({ sender }) => {
    const url = sender.tab?.url;
    if (!url) return null;
    return (await episodeOverrides.getValue())[url] ?? null;
  });

  onMessage("clearEpisodeOverride", async ({ data }) => {
    const all = await episodeOverrides.getValue();
    if (all[data.url]) {
      delete all[data.url];
      await episodeOverrides.setValue(all);
    }
  });

  onMessage("stopTabSession", async ({ sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    // Clear the published media so any frame that re-pulls gets nothing, then
    // recheck so an active player iframe tears down its (now stale) session.
    await clearTabSession(tabId);
    void sendMessage("recheck", undefined, tabId);
  });

  onMessage("setEpisode", async ({ data, sender }) => {
    // A show page with no episode in its URL — remember the user's S/E for THIS
    // page URL, then re-resolve the tab so the session applies it and scrobbles.
    const tabId = data.tabId ?? sender.tab?.id;
    // The override is keyed by the tab's URL; from the popup we look it up.
    const url =
      sender.tab?.url ??
      (tabId !== undefined ? (await browser.tabs.get(tabId).catch(() => null))?.url : undefined);
    if (!url) return { ok: false };
    const all = await episodeOverrides.getValue();
    all[url] = { season: data.season, episode: data.episode };
    await episodeOverrides.setValue(all);
    if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
    return { ok: true };
  });

  onMessage("publishManualContext", async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const all = await manualContexts.getValue();
    if (data === null) {
      if (all[tabId]) {
        delete all[tabId];
        await manualContexts.setValue(all);
      }
      return;
    }
    if (all[tabId]?.recipeId === data.recipeId && all[tabId]?.pageKey === data.pageKey) return;
    all[tabId] = data;
    await manualContexts.setValue(all);
  });

  onMessage("getManualContext", async ({ data, sender }) => {
    const tabId = data?.tabId ?? sender.tab?.id;
    if (tabId === undefined) return null;
    return (await manualContexts.getValue())[tabId] ?? null;
  });

  // --- corrections ---
  onMessage("searchTrakt", async ({ data }) => {
    try {
      return await search(data.query, data.type);
    } catch {
      return [];
    }
  });

  onMessage("saveCorrection", async ({ data, sender }) => {
    const key = resolutionCacheKey(data.media);
    const corr = await corrections.getValue();
    corr[key] = data.identity;
    await corrections.setValue(corr);
    // Drop any stale auto-resolution so the correction takes effect.
    const cache = await resolutionCache.getValue();
    if (cache[key]) {
      delete cache[key];
      await resolutionCache.setValue(cache);
    }
    // Re-resolve the current session in the tab (replaces the wrong scrobble).
    const tabId = data.tabId ?? sender.tab?.id;
    if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
  });

  onMessage("searchAniList", async ({ data }) => {
    try {
      return await searchAniList(data.query);
    } catch {
      return [];
    }
  });

  // Pin/block the AniList entry for this TMDB item — a local override above Fribb.
  onMessage("setAniListMatch", async ({ data, sender }) => {
    const tmdbId = data.media.ids?.tmdb;
    if (tmdbId !== undefined) {
      // TMDB-keyed crosswalk override (the derived / multi-track path).
      const ov = await animapOverrides.getValue();
      ov.forward[forwardKey(Number(tmdbId), data.media.season)] = data.anilistId;
      await animapOverrides.setValue(ov);
    } else {
      // No tmdb id → an AniList-NATIVE recipe resolved by title. Pin the entry under
      // the title key (or null = "not on AniList"). Mirrors saveCorrection for Trakt.
      const key = anilistCacheKey(data.media);
      const corr = await anilistCorrections.getValue();
      if (data.anilistId === null) {
        corr[key] = null;
      } else {
        const identity = await resolveAniListById(data.anilistId);
        if (!identity) return { ok: false, error: "couldn't load that AniList entry" };
        corr[key] = identity;
      }
      await anilistCorrections.setValue(corr);
      // Drop any stale auto-resolution so the pin takes effect immediately.
      const cache = await anilistResolutionCache.getValue();
      if (key in cache) {
        delete cache[key];
        await anilistResolutionCache.setValue(cache);
      }
    }
    const tabId = data.tabId ?? sender.tab?.id;
    if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
    return { ok: true };
  });

  // Undo an AniList override (pin or "Not on AniList") → back to auto-resolution
  // (the Fribb crosswalk for a tmdb item, or the title search for a native one).
  onMessage("resetAniListMatch", async ({ data, sender }) => {
    const tmdbId = data.media.ids?.tmdb;
    if (tmdbId !== undefined) {
      const ov = await animapOverrides.getValue();
      const key = forwardKey(Number(tmdbId), data.media.season);
      if (key in ov.forward) {
        delete ov.forward[key];
        await animapOverrides.setValue(ov);
      }
    } else {
      const key = anilistCacheKey(data.media);
      const corr = await anilistCorrections.getValue();
      if (key in corr) {
        delete corr[key];
        await anilistCorrections.setValue(corr);
      }
      const cache = await anilistResolutionCache.getValue();
      if (key in cache) {
        delete cache[key];
        await anilistResolutionCache.setValue(cache);
      }
    }
    const tabId = data.tabId ?? sender.tab?.id;
    if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
    return { ok: true };
  });

  // The user confirmed a rewatch of a COMPLETED AniList cour → write REPEATING
  // (or re-COMPLETED + repeat++ on the final episode) and update the badge.
  onMessage("confirmRewatch", async ({ data, sender }) => {
    try {
      const item = await getAdapter("anilist").resolve(data.media);
      if (!item || item.tracker !== "anilist") return { ok: false, error: "not found on AniList" };
      const result = await confirmAniListRewatch(item, data.media);
      if (!result.ok) {
        return {
          ok: false,
          error: result.reason === "not_connected" ? "Not connected to AniList" : result.httpError,
        };
      }
      // Reflect it on the badge (and gate the rating prompt on completion).
      const tabId = data.tabId ?? sender.tab?.id;
      if (tabId !== undefined) {
        const ep = data.media.episode;
        void sendMessage(
          "scrobbleStatus",
          {
            state: "scrobbled",
            title: `${item.title}${ep !== undefined ? ` E${ep}` : ""}`,
            detail: result.completed ? "rewatch complete on AniList" : "rewatching on AniList",
            completed: result.completed,
          },
          { tabId, frameId: 0 },
        ).catch(() => {});
      }
      return { ok: true, completed: result.completed };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  // --- ratings & notes (routed: Trakt comment-per-level / AniList cour entry) ---
  // Which affordances the badge should render for the routed tracker. Trakt:
  // movie or episode/season/show. AniList: a single "cour" + the user's score format.
  onMessage("getRatingMeta", async ({ data }) => {
    const tracker = data.tracker ?? "trakt";
    const levels = getAdapter(tracker).ratingLevels(data.media);
    if (tracker !== "anilist") return { levels };
    return { levels, scoreFormat: (await viewerScoreFormat()) ?? undefined };
  });

  onMessage("getReview", async ({ data }) => {
    if ((data.tracker ?? "trakt") === "anilist") return anilistGetReview(data.media);
    return traktGetReview(data.media, data.level as ReviewLevel); // trakt branch: never "cour"
  });

  onMessage("rateItem", async ({ data }) => {
    if ((data.tracker ?? "trakt") === "anilist") return anilistRate(data.media, data.rating);
    return traktRate(data.media, data.level as ReviewLevel, data.rating);
  });

  onMessage("unrateItem", async ({ data }) => {
    if ((data.tracker ?? "trakt") === "anilist") return anilistUnrate(data.media);
    return traktUnrate(data.media, data.level as ReviewLevel);
  });

  onMessage("saveNote", async ({ data }) => {
    if ((data.tracker ?? "trakt") === "anilist") return anilistSaveNote(data.media, data.text);
    return traktSaveNote(data.media, data.level as ReviewLevel, data.text, data.spoiler);
  });

  onMessage("deleteNote", async ({ data }) => {
    if ((data.tracker ?? "trakt") === "anilist") return anilistDeleteNote(data.media);
    return traktDeleteNote(data.media, data.level as ReviewLevel);
  });

  // --- per-tab session coordination ---
  onMessage("publishMedia", async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const all = await tabSessions.getValue();
    const prev = all[tabId];
    all[tabId] = {
      media: data.media,
      tracker: data.tracker,
      trackers: data.trackers,
      videoSelector: data.videoSelector,
      frame: data.frame,
      watchedThreshold: data.watchedThreshold,
      // Keep progress across a same-session re-publish (recheck), but start fresh
      // after a finished item — else the next episode inherits ~100% (a stray stop).
      progress: prev?.ended ? 0 : (prev?.progress ?? 0),
      updatedAt: Date.now(),
    };
    await tabSessions.setValue(all);
  });

  onMessage("getTabMedia", async ({ data, sender }) => {
    const tabId = data?.tabId ?? sender.tab?.id;
    if (tabId === undefined) return null;
    const session = (await tabSessions.getValue())[tabId];
    return session
      ? {
          media: session.media,
          tracker: session.tracker,
          trackers: session.trackers,
          videoSelector: session.videoSelector,
          frame: session.frame,
          watchedThreshold: session.watchedThreshold,
        }
      : null;
  });

  onMessage("getWatchedState", async ({ data, sender }) => {
    const tabId = data?.tabId ?? sender.tab?.id;
    if (tabId === undefined) return null;
    const session = (await tabSessions.getValue())[tabId];
    if (!session) return null;
    try {
      const tracker = routeTracker(session.tracker, session.media.mediaType);
      const adapter = getAdapter(tracker);
      const item = await adapter.resolve(session.media);
      if (!item) return null;
      return await adapter.watchedState(item);
    } catch {
      return null; // reads degrade quietly — the popup just omits the line
    }
  });

  onMessage("updateProgress", async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const all = await tabSessions.getValue();
    const session = all[tabId];
    if (!session) return;
    all[tabId] = { ...session, progress: data, updatedAt: Date.now() };
    await tabSessions.setValue(all);
  });

  onMessage("endSession", async ({ sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    // Don't drop the record — the item just finished, and the popup/badge should
    // still offer rate + fix on it. Mark it ended so the tab-close reconcile skips
    // it (the stop already fired). A fresh play (publishMedia) overwrites it; a real
    // nav-away (stopTabSession) still clears it.
    const all = await tabSessions.getValue();
    const session = all[tabId];
    if (!session) return;
    all[tabId] = { ...session, ended: true };
    await tabSessions.setValue(all);
  });

  // Playing frame → relay to the top frame's badge, mirror to per-tab storage
  // (so the popup can show it), and reflect the state on the toolbar icon.
  onMessage("reportScrobble", async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    // Tab may have closed between the report and this push — swallow "No tab with id".
    void sendMessage("scrobbleStatus", data, { tabId, frameId: 0 }).catch(() => {});
    const all = await tabStatus.getValue();
    if (data.hide) delete all[tabId];
    else all[tabId] = data;
    await tabStatus.setValue(all);
    setActionBadge(tabId, data.hide ? null : data);
  });

  // Top frame reports iframe origins it has seen; accumulate the union per tab so
  // the popup can offer late-loading player frames (constraint #5 enable flow).
  onMessage("reportFrameOrigins", async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined || data.length === 0) return;
    const all = await tabFrameOrigins.getValue();
    const merged = [...new Set([...(all[tabId] ?? []), ...data])];
    if (merged.length !== (all[tabId]?.length ?? 0)) {
      all[tabId] = merged;
      await tabFrameOrigins.setValue(all);
    }
  });

  // Reconcile a stop if a tab dies before a clean one (point: lost stops).
  browser.tabs.onRemoved.addListener(async (tabId) => {
    // The tab is gone — drop its accumulated player-frame origins + status.
    await clearTabStatus(tabId);
    const frames = await tabFrameOrigins.getValue();
    if (frames[tabId]) {
      delete frames[tabId];
      await tabFrameOrigins.setValue(frames);
    }
    // Drop the tab's manual context (the remembered selections persist).
    const mctx = await manualContexts.getValue();
    if (mctx[tabId]) {
      delete mctx[tabId];
      await manualContexts.setValue(mctx);
    }
    const all = await tabSessions.getValue();
    const session = all[tabId];
    if (!session) return;
    await clearTabSession(tabId);
    // Already stopped (ended) or never really started → nothing to reconcile.
    if (session.ended || session.progress <= 0) return;
    try {
      // Route the reconciling stop to the same adapter the session used. For Trakt
      // this sends the final /scrobble/stop; for AniList it commits the threshold
      // write if the last progress crossed it (otherwise a quiet no-op).
      const adapter = getAdapter(session.tracker);
      const item = await adapter.resolve(session.media);
      if (!item) return;
      await adapter.recordProgress(
        item,
        session.media,
        session.progress,
        "stop",
        session.watchedThreshold,
      );
    } catch {
      // not connected / network — nothing to reconcile
    }
  });

  // A real navigation/reload starts a fresh page — clear any stale toolbar badge
  // + mirrored status. (SPA history changes don't report `loading`, so they're
  // left to the content script's reconcile/hide, avoiding a flicker.)
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") void clearTabStatus(tabId);
  });
});

/**
 * MULTI-TRACK (docs/MULTI-TRACK.md): record the DERIVED tracker(s) for a scrobble,
 * alongside the native one. The native item is already resolved+recorded; for each
 * other toggled tracker we derive its numbering via the anime-map crosswalk, then
 * resolve + record it. Independent + advance-only (each adapter owns its own watched
 * decision + never-lower rule). Never guesses: a crosswalk miss is a silent skip
 * (the item isn't anime / isn't mapped), an ambiguous match refuses with a warning.
 */
/** Promote a derived outcome to the top-level reply shape (used when the native
 * tracker isn't enabled, so a derived tracker drives the badge). */
function derivedToReply(d: DerivedOutcome): ScrobbleReply {
  const reason: ScrobbleReply["reason"] | undefined = d.ok
    ? undefined
    : d.reason === "no_match" || d.skipped
      ? "unresolved"
      : d.reason === "numbering_mismatch" ||
          d.reason === "not_connected" ||
          d.reason === "no_episode" ||
          d.reason === "needs_rewatch"
        ? d.reason
        : "http";
  return {
    ok: d.ok,
    resolved: !d.skipped && d.reason !== "unresolved",
    action: d.action,
    reason,
    completed: d.completed,
    resolvedTitle: d.resolvedTitle,
    resolvedYear: d.resolvedYear,
    resolvedEpisodes: d.resolvedEpisodes,
    primaryTracker: d.tracker,
  };
}

/**
 * MULTI-TRACK read-only resolve: what each enabled tracker matches for this media
 * (native direct + derived via the crosswalk). Mirrors the record fan-out but writes
 * nothing — powers the rate/correction UI's per-tracker destination readout, so it
 * can show "Trakt → The Boondocks / AniList → not found" and gate actions.
 */
async function resolveAcross(
  media: ParsedMedia,
  trackers: Tracker[],
  overrides: AnimapOverrides,
): Promise<TrackerResolution[]> {
  const native = inferNativeTracker(media, trackers); // native must be an enabled tracker
  const nativeEnabled = trackers.includes(native);
  const soloFallback = !nativeEnabled; // no enabled native anchor to bridge from
  const needNative = nativeEnabled || (native === "anilist" && trackers.includes("trakt"));
  let nativeItem: TrackedItem | null = null;
  if (needNative) {
    try {
      nativeItem = await getAdapter(native).resolve(media);
    } catch {
      nativeItem = null;
    }
  }
  // Resolve a tracker directly (its own id → title) — the solo-fallback path.
  const resolveDirect = async (tk: Tracker): Promise<TrackerResolution> => {
    const item = await getAdapter(tk)
      .resolve(media)
      .catch(() => null);
    return item
      ? { tracker: tk, resolved: true, title: item.title, id: item.id }
      : { tracker: tk, resolved: false, reason: "no_match" };
  };
  const out: TrackerResolution[] = [];
  for (const tk of trackers) {
    if (tk === native) {
      out.push(
        nativeItem
          ? { tracker: tk, resolved: true, title: nativeItem.title, id: nativeItem.id }
          : { tracker: tk, resolved: false, reason: "unresolved" },
      );
      continue;
    }
    const d = deriveMediaWith(tk, media, nativeItem, overrides);
    if (d.kind === "miss") {
      out.push(
        soloFallback
          ? await resolveDirect(tk)
          : { tracker: tk, resolved: false, reason: "no_match" },
      );
      continue;
    }
    if (d.kind === "ambiguous") {
      out.push({ tracker: tk, resolved: false, reason: "ambiguous" });
      continue;
    }
    try {
      const item =
        tk === "anilist" && d.anilistId !== undefined
          ? await resolveAniListById(d.anilistId)
          : await getAdapter(tk).resolve(d.media);
      out.push(
        item
          ? { tracker: tk, resolved: true, title: item.title, id: item.id }
          : { tracker: tk, resolved: false, reason: "unresolved" },
      );
    } catch {
      out.push({ tracker: tk, resolved: false, reason: "http" });
    }
  }
  return out;
}

async function recordDerivedTrackers(
  nativeItem: TrackedItem | null,
  targets: Tracker[],
  data: ScrobbleRequest,
  overrides: AnimapOverrides,
  // True when NO enabled tracker speaks the page's numbering natively — i.e. the
  // crosswalk has no native partner to bridge FROM. Then a miss isn't "skip"; the
  // target resolves itself (its own id, else title) with the scraped episode.
  // Genuine multi-track (an enabled native anchor) keeps skip-on-miss.
  soloFallback: boolean,
): Promise<DerivedOutcome[]> {
  const out: DerivedOutcome[] = [];

  // Record a resolved item and shape its reply (year/episodes included so the badge
  // shows them). Shared by the crosswalk path and the solo title fallback.
  const record = async (
    target: Tracker,
    item: TrackedItem,
    media: ParsedMedia,
  ): Promise<DerivedOutcome> => {
    const r = await getAdapter(target).recordProgress(
      item,
      media,
      data.progress,
      data.action,
      data.watchedThreshold ?? 0.8,
    );
    return {
      tracker: target,
      ok: r.ok,
      action: r.action,
      reason: r.ok ? undefined : r.reason,
      completed: r.completed,
      resolvedTitle: item.title,
      resolvedYear: item.year,
      resolvedEpisodes: item.tracker === "anilist" ? (item.episodes ?? undefined) : undefined,
    };
  };

  for (const target of targets) {
    const d = deriveMediaWith(target, data.media, nativeItem, overrides);
    if (d.kind === "miss") {
      // No crosswalk row. Standing alone (no enabled native anchor) ⇒ resolve this
      // tracker directly rather than give up — a mislabeled/unmapped id degrades to
      // a title match instead of "not found". The adapter's own guardrails apply.
      if (soloFallback) {
        const item = await getAdapter(target)
          .resolve(data.media)
          .catch(() => null);
        if (item) {
          out.push(await record(target, item, data.media));
          continue;
        }
      }
      out.push({ tracker: target, ok: false, skipped: true, reason: "no_match" });
      continue;
    }
    if (d.kind === "ambiguous") {
      out.push({ tracker: target, ok: false, reason: "numbering_mismatch" });
      continue;
    }
    let item: TrackedItem | null;
    try {
      item =
        target === "anilist" && d.anilistId !== undefined
          ? await resolveAniListById(d.anilistId)
          : await getAdapter(target).resolve(d.media);
    } catch {
      out.push({ tracker: target, ok: false, reason: "http" });
      continue;
    }
    if (!item) {
      out.push({ tracker: target, ok: false, reason: "unresolved" });
      continue;
    }
    out.push(await record(target, item, d.media));
  }
  return out;
}

// AniList rating + notes live in lib/anilist/review.ts; Trakt rating + notes in
// lib/trakt/review.ts. The message handlers above just dispatch by tracker.

// MV3 (Chrome + Firefox 109+) expose `action`; Firefox MV2 uses `browserAction`.
const tabAction = browser.action ?? browser.browserAction;

// Cache the brand icon bitmaps (per size) so we only fetch/decode them once.
// Literal paths — WXT types getURL to the known public files only.
const ICON_URL: Record<number, string> = {
  16: browser.runtime.getURL("/icon/16.png"),
  32: browser.runtime.getURL("/icon/32.png"),
};
const baseIconCache = new Map<number, Promise<ImageBitmap>>();
function baseIcon(size: number): Promise<ImageBitmap> {
  let p = baseIconCache.get(size);
  if (!p) {
    const url = ICON_URL[size] ?? ICON_URL[32];
    p = fetch(url as string)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b));
    baseIconCache.set(size, p);
  }
  return p;
}

/** The brand icon with a status dot composited in the corner (clean at icon size,
 * unlike a text glyph). `dot === null` ⇒ the plain icon. */
async function drawIcon(size: number, dot: string | null): Promise<ImageData> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(await baseIcon(size), 0, 0, size, size);
  if (dot) {
    const r = size * 0.3;
    const cx = size - r - size * 0.02;
    const cy = size - r - size * 0.02;
    ctx.beginPath(); // white ring so the dot reads against the icon
    ctx.arc(cx, cy, r + Math.max(1, size * 0.06), 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = dot;
    ctx.fill();
  }
  return ctx.getImageData(0, 0, size, size);
}

/** Reflect a scrobble status on the tab's toolbar icon (ambient, off-page): a
 * status-coloured dot on the brand mark. Falls back to a coloured badge dot if
 * canvas/setIcon isn't available. */
function setActionBadge(tabId: number, status: BadgeStatus | null): void {
  const dot = statusDotColor(status);
  // All tabAction calls below can race a tab close → "No tab with id"; ignore it.
  void tabAction.setBadgeText({ tabId, text: "" }).catch(() => {}); // retire the old text glyph
  void (async () => {
    try {
      const [i16, i32] = await Promise.all([drawIcon(16, dot), drawIcon(32, dot)]);
      // setIcon's imageData typing differs across action/browserAction polyfills.
      const setIcon = tabAction.setIcon as (d: {
        tabId: number;
        imageData: Record<number, ImageData>;
      }) => Promise<void>;
      await setIcon({ tabId, imageData: { 16: i16, 32: i32 } });
    } catch {
      // No OffscreenCanvas (older Firefox) — fall back to a coloured badge dot.
      void tabAction.setBadgeText({ tabId, text: dot ? "●" : "" }).catch(() => {});
      if (dot) void tabAction.setBadgeBackgroundColor({ tabId, color: dot }).catch(() => {});
    }
  })();
}

/** Drop a tab's mirrored status + clear its toolbar badge. */
async function clearTabStatus(tabId: number): Promise<void> {
  setActionBadge(tabId, null);
  const all = await tabStatus.getValue();
  if (all[tabId]) {
    delete all[tabId];
    await tabStatus.setValue(all);
  }
}

async function clearTabSession(tabId: number): Promise<void> {
  // Note: does NOT clear tabFrameOrigins — a `stop` (e.g. the mid-playback
  // threshold commit) ends the scrobble session but the player iframe is still
  // on the page, so the popup should keep offering it. Frame origins are cleared
  // only when the tab is removed (see tabs.onRemoved).
  const all = await tabSessions.getValue();
  if (all[tabId]) {
    delete all[tabId];
    await tabSessions.setValue(all);
  }
}

/**
 * Decide whether the calling frame may scrobble this tab. The first frame to
 * `start` (or any frame if the current owner went stale) claims ownership;
 * non-owners are turned away until a `stop` releases it.
 */
async function claimScrobbleOwner(
  tabId: number,
  frameId: number,
  action: "start" | "pause" | "stop",
): Promise<boolean> {
  const all = await tabSessions.getValue();
  const session = all[tabId];
  const owner = session?.ownerFrameId;
  const stale = !session || Date.now() - session.updatedAt > OWNER_TTL_MS;

  const isOwner = owner === frameId || owner === undefined || stale;
  if (!isOwner) return false;

  if (session) {
    session.ownerFrameId = action === "stop" ? undefined : frameId;
    session.updatedAt = Date.now();
    await tabSessions.setValue(all);
  }
  return true;
}

/**
 * Fetch + cache the CDN recipe list — one tracker-agnostic file (each recipe
 * carries its own `tracker`). Skips when the cache is fresh (unless forced), and
 * sends `If-None-Match` so an unchanged list returns 304 and reuses the cache
 * (only the freshness timestamp is bumped). Validates with parseLibrary so a
 * malformed list never lands in the cache. Best-effort: on any failure the
 * existing cache (or the bundled seed) stays in use.
 */
async function fetchRemoteRecipes(
  force = false,
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    const current = await remoteRecipes.getValue();
    if (!force && current && Date.now() - current.fetchedAt < RECIPES.refreshMs) {
      return { ok: true, count: current.recipes.length };
    }
    const res = await fetch(
      RECIPES.url,
      current?.etag ? { headers: { "If-None-Match": current.etag } } : undefined,
    );
    // 304 Not Modified — the list is unchanged; keep the cache, just mark it fresh
    // so we don't re-request until the next TTL window.
    if (res.status === 304 && current) {
      await remoteRecipes.setValue({ ...current, fetchedAt: Date.now() });
      return { ok: true, count: current.recipes.length };
    }
    if (!res.ok) {
      return { ok: false, count: current?.recipes.length ?? 0, error: `HTTP ${res.status}` };
    }
    const library = parseLibrary((await res.json()) as unknown);
    const etag = res.headers.get("ETag") ?? undefined;
    await remoteRecipes.setValue({ recipes: library.recipes, fetchedAt: Date.now(), etag });
    await mergeLibraryLinks(library.links);
    await graduateRecipes(library.recipes);
    return { ok: true, count: library.recipes.length };
  } catch (e) {
    return { ok: false, count: 0, error: errMsg(e) };
  }
}

/**
 * Recipe graduation: once a custom recipe's identical twin appears in the library
 * (the user's contribution landed), retire the local copy so it stops shadowing +
 * consuming the synced set. A diverged custom recipe is kept (user edits win).
 */
async function graduateRecipes(libraryRecipes: Recipe[]): Promise<void> {
  const libById = new Map(libraryRecipes.map((r) => [r.id, JSON.stringify(r)]));
  const custom = await customRecipes.getValue();
  const kept = custom.filter((r) => libById.get(r.id) !== JSON.stringify(r));
  if (kept.length !== custom.length) await customRecipes.setValue(kept);
}

/** True if a user link is identical to its library version (so it can graduate
 *  cleanly). A diverged user copy keeps shadowing instead. */
function linkMatchesLibrary(cur: QuickLinkSite, l: LibraryLink): boolean {
  return (
    cur.name === l.name &&
    (cur.tracker ?? "trakt") === l.tracker &&
    cur.movie === l.movie &&
    cur.tv === l.tv &&
    cur.anime === l.anime &&
    cur.search === l.search
  );
}

/**
 * Merge shared library links into the user's quick-links store. New ones arrive
 * DISABLED (the user enables favourites); existing library-sourced entries get
 * their templates/name refreshed but keep the user's enabled choice. A user-owned
 * entry whose id now appears in the library (i.e. their contribution landed) and
 * matches it GRADUATES to a library entry, keeping its enabled toggle; a diverged
 * user entry is left untouched (it shadows the library version).
 */
async function mergeLibraryLinks(links: LibraryLink[]): Promise<void> {
  if (links.length === 0) return;
  const existing = await quickLinks.getValue();
  const byId = new Map(existing.map((s) => [s.id, s]));
  let changed = false;
  for (const l of links) {
    const cur = byId.get(l.id);
    const fields = {
      name: l.name,
      tracker: l.tracker,
      movie: l.movie,
      tv: l.tv,
      anime: l.anime,
      search: l.search,
    };
    if (!cur) {
      byId.set(l.id, { id: l.id, enabled: false, source: "library", ...fields });
      changed = true;
    } else if (cur.source === "library") {
      byId.set(l.id, { ...cur, ...fields });
      changed = true;
    } else if (linkMatchesLibrary(cur, l)) {
      // Graduate: the user's contributed link is now in the library, unchanged —
      // adopt it (keep their enabled toggle), freeing it from the synced set.
      byId.set(l.id, { ...cur, source: "library", ...fields });
      changed = true;
    }
  }
  if (changed) await quickLinks.setValue([...byId.values()]);
}

/** Re-register content scripts for every enabled origin (idempotent). */
async function reconcileRegistrations(): Promise<void> {
  try {
    const origins = await enabledOrigins.getValue();
    if (origins.length === 0) return;
    const registered = new Set(
      (await browser.scripting.getRegisteredContentScripts()).map((s) => s.id),
    );
    for (const origin of origins) {
      if (!registered.has(siteId(origin))) await registerScript(origin);
    }
  } catch {
    // best effort — a missing host permission just means that site stays off
  }
}

async function registerScript(origin: string): Promise<void> {
  await browser.scripting.registerContentScripts([
    {
      id: siteId(origin),
      matches: [`${origin}/*`],
      js: ["content-scripts/content.js"],
      runAt: "document_idle",
      allFrames: true,
      persistAcrossSessions: true,
    },
  ]);
}

/**
 * Register the runtime content script for a single origin. The popup must have
 * already obtained the host permission via a user gesture. `persistAcrossSessions`
 * keeps the registration across browser restarts, so we don't re-register.
 *
 * `enabledOrigins` is persisted FIRST and unconditionally — it's the source of truth
 * for the popup's enabled-state AND for reconcileRegistrations() — so it must NOT be
 * gated on the scripting call. Right after the permission prompt is accepted, the
 * new host permission often isn't visible to this service worker yet, so the first
 * registerContentScripts() can throw; that used to leave the origin unpersisted, so
 * the popup still showed "Enable" until a second click (a known bug). Now we persist,
 * then register best-effort with one retry, and reconcileRegistrations() covers any
 * remaining gap on the next wake (the popup also injects the current tab directly).
 */
async function registerSite(origin: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const list = await enabledOrigins.getValue();
    if (!list.includes(origin)) await enabledOrigins.setValue([...list, origin]);
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
  await ensureRegistered(origin).catch(() => {});
  return { ok: true };
}

/**
 * Idempotently register the content script for an origin, tolerating the brief
 * post-grant window where the new host permission hasn't propagated to the SW yet:
 * one short retry, then leave it to reconcileRegistrations() on the next wake.
 */
async function ensureRegistered(origin: string): Promise<void> {
  const id = siteId(origin);
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length > 0) return;
  try {
    await registerScript(origin);
  } catch {
    await new Promise((r) => setTimeout(r, 200));
    await registerScript(origin);
  }
}

async function unregisterSite(origin: string): Promise<{ ok: boolean }> {
  const id = siteId(origin);
  try {
    await browser.scripting.unregisterContentScripts({ ids: [id] });
  } catch {
    // not registered — ignore
  }
  const list = await enabledOrigins.getValue();
  await enabledOrigins.setValue(list.filter((o) => o !== origin));
  return { ok: true };
}
