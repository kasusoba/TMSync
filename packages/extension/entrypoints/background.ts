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
  resolve as anilistResolve,
  saveNotes as anilistSaveNotes,
  saveRating as anilistSaveRating,
  searchAniList,
  viewerScoreFormat,
} from "@/lib/anilist/client";
import { ANILIST } from "@/lib/anilist/config";
import { type AnimapOverrides, deriveMediaWith, forwardKey } from "@/lib/animap/derive";
import { bundledLinks } from "@/lib/recipes";
import { statusDotColor } from "@/lib/scrobble/action-badge";
import {
  type QuickLinkSite,
  anilistNotes,
  anilistRatings,
  animapOverrides,
  corrections,
  customRecipes,
  enabledOrigins,
  episodeOverrides,
  manualContexts,
  manualSelections,
  notes,
  quickLinks,
  ratings,
  remoteRatings,
  remoteRecipes,
  resolutionCache,
  tabFrameOrigins,
  tabSessions,
  tabStatus,
} from "@/lib/storage";
import { getAdapter, inferNativeTracker, routeTracker } from "@/lib/tracker";
import type { TrackedItem, Tracker } from "@/lib/tracker/types";
import { connect, disconnect, getRedirectUri, isConnected } from "@/lib/trakt/auth";
import {
  TraktNotConnectedError,
  commentItem,
  deleteComment,
  exportLetterboxd,
  getRemoteRating,
  postComment,
  rate,
  resolve,
  search,
  updateComment,
} from "@/lib/trakt/client";
import type { ReviewLevel } from "@/lib/trakt/types";
import { buildRatingBody, resolutionCacheKey, reviewKey } from "@/lib/trakt/util";
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
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

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

  // One-time: lift any per-recipe `links` (the old quick-links shape) into the
  // standalone quickLinks store, then strip them from the recipes.
  void migrateRecipeLinks();

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
    const native = inferNativeTracker(data.media);
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
          resolvedTitle: result.reason === "no_episode" ? undefined : nativeItem.title,
          resolvedYear: result.reason === "no_episode" ? undefined : nativeItem.year,
          httpError: result.httpError,
          primaryTracker: native,
        };
      }
    }

    // Derive + record every OTHER enabled tracker via the crosswalk (+ overrides).
    const derived = await recordDerivedTrackers(
      nativeItem,
      enabled.filter((t) => t !== native),
      data,
      await animapOverrides.getValue(),
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
    if (data.media.tmdbId === undefined) {
      return { ok: false, error: "no TMDB id on this item to key the override" };
    }
    const ov = await animapOverrides.getValue();
    ov.forward[forwardKey(data.media.tmdbId, data.media.season)] = data.anilistId;
    await animapOverrides.setValue(ov);
    const tabId = data.tabId ?? sender.tab?.id;
    if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
    return { ok: true };
  });

  // Undo an AniList override (pin or "Not on AniList") → back to the Fribb crosswalk.
  onMessage("resetAniListMatch", async ({ data, sender }) => {
    if (data.media.tmdbId !== undefined) {
      const ov = await animapOverrides.getValue();
      const key = forwardKey(data.media.tmdbId, data.media.season);
      if (key in ov.forward) {
        delete ov.forward[key];
        await animapOverrides.setValue(ov);
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
    const level = data.level as ReviewLevel; // trakt branch: never "cour"
    try {
      const identity = await resolve(data.media);
      if (!identity) return { rating: null, note: null };
      const key = reviewKey(identity, level, data.media.season, data.media.episode);
      const localRating = (await ratings.getValue())[key] ?? null;
      // Prefer a recent local action; otherwise sync the rating from Trakt so
      // ratings set on the website show up too. Mirror the remote value locally.
      let rating = localRating;
      if (localRating === null) {
        try {
          const remote = await getRemoteRating(
            identity,
            level,
            data.media.season,
            data.media.episode,
          );
          if (remote !== null) {
            rating = remote;
            const all = await ratings.getValue();
            all[key] = remote;
            await ratings.setValue(all);
          }
        } catch {
          // not connected / network — fall back to local (null)
        }
      }
      const stored = (await notes.getValue())[key];
      return { rating, note: stored ? { text: stored.text, spoiler: stored.spoiler } : null };
    } catch {
      return { rating: null, note: null };
    }
  });

  onMessage("rateItem", async ({ data }) => {
    if ((data.tracker ?? "trakt") === "anilist") return anilistRate(data.media, data.rating);
    const level = data.level as ReviewLevel;
    try {
      const identity = await resolve(data.media);
      if (!identity) return { ok: false, error: "not found on Trakt" };
      const body = buildRatingBody(
        identity,
        level,
        data.media.season,
        data.media.episode,
        data.rating,
      );
      if (!body) return { ok: false, error: "missing season/episode" };
      const out = await rate(body);
      if (!out.ok) return { ok: false, error: out.error ?? `failed (${out.status})` };
      const key = reviewKey(identity, level, data.media.season, data.media.episode);
      const all = await ratings.getValue();
      all[key] = data.rating;
      await ratings.setValue(all);
      await remoteRatings.setValue({}); // invalidate the sync cache
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  onMessage("unrateItem", async ({ data }) => {
    if ((data.tracker ?? "trakt") === "anilist") return anilistUnrate(data.media);
    const level = data.level as ReviewLevel;
    try {
      const identity = await resolve(data.media);
      if (!identity) return { ok: false, error: "not found on Trakt" };
      const body = buildRatingBody(identity, level, data.media.season, data.media.episode);
      if (!body) return { ok: false, error: "missing season/episode" };
      const out = await rate(body, true);
      if (!out.ok) return { ok: false, error: out.error ?? `failed (${out.status})` };
      const key = reviewKey(identity, level, data.media.season, data.media.episode);
      const all = await ratings.getValue();
      delete all[key];
      await ratings.setValue(all);
      await remoteRatings.setValue({}); // invalidate the sync cache
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  onMessage("saveNote", async ({ data }) => {
    if ((data.tracker ?? "trakt") === "anilist") return anilistSaveNote(data.media, data.text);
    const level = data.level as ReviewLevel;
    try {
      const text = data.text.trim();
      if (wordCount(text) < 5)
        return { ok: false, error: "Trakt needs a note of at least 5 words" };
      const identity = await resolve(data.media);
      if (!identity) return { ok: false, error: "not found on Trakt" };
      const key = reviewKey(identity, level, data.media.season, data.media.episode);
      const all = await notes.getValue();
      const existing = all[key];
      if (existing) {
        const out = await updateComment(existing.commentId, text, data.spoiler);
        if (!out.ok) return { ok: false, error: out.error };
        all[key] = { ...existing, text, spoiler: data.spoiler };
      } else {
        const ref = await commentItem(identity, level, data.media.season, data.media.episode);
        if ("error" in ref) return { ok: false, error: ref.error };
        const out = await postComment(ref.item, text, data.spoiler);
        if (!out.ok || out.id === undefined)
          return { ok: false, error: out.error ?? "comment failed" };
        all[key] = { commentId: out.id, text, spoiler: data.spoiler };
      }
      await notes.setValue(all);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  onMessage("deleteNote", async ({ data }) => {
    if ((data.tracker ?? "trakt") === "anilist") return anilistDeleteNote(data.media);
    const level = data.level as ReviewLevel;
    try {
      const identity = await resolve(data.media);
      if (!identity) return { ok: false, error: "not found on Trakt" };
      const key = reviewKey(identity, level, data.media.season, data.media.episode);
      const all = await notes.getValue();
      const existing = all[key];
      if (!existing) return { ok: true };
      const out = await deleteComment(existing.commentId);
      if (!out.ok) return { ok: false, error: out.error };
      delete all[key];
      await notes.setValue(all);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  // --- per-tab session coordination ---
  onMessage("publishMedia", async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const all = await tabSessions.getValue();
    all[tabId] = {
      media: data.media,
      tracker: data.tracker,
      trackers: data.trackers,
      videoSelector: data.videoSelector,
      frame: data.frame,
      watchedThreshold: data.watchedThreshold,
      progress: all[tabId]?.progress ?? 0,
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
    await clearTabSession(tabId);
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
    if (session.progress <= 0) return;
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
  const native = inferNativeTracker(media);
  const needNative =
    trackers.includes(native) || (native === "anilist" && trackers.includes("trakt"));
  let nativeItem: TrackedItem | null = null;
  if (needNative) {
    try {
      nativeItem = await getAdapter(native).resolve(media);
    } catch {
      nativeItem = null;
    }
  }
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
      out.push({ tracker: tk, resolved: false, reason: "no_match" });
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
): Promise<DerivedOutcome[]> {
  const out: DerivedOutcome[] = [];
  for (const target of targets) {
    const d = deriveMediaWith(target, data.media, nativeItem, overrides);
    if (d.kind === "miss") {
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
    const r = await getAdapter(target).recordProgress(
      item,
      d.media,
      data.progress,
      data.action,
      data.watchedThreshold ?? 0.8,
    );
    out.push({
      tracker: target,
      ok: r.ok,
      action: r.action,
      reason: r.ok ? undefined : r.reason,
      completed: r.completed,
      resolvedTitle: item.title,
    });
  }
  return out;
}

// --- AniList rating + private note (step 7) ---
// AniList rates the COUR ENTRY only — score + private notes both write through
// SaveMediaListEntry, keyed by Media id (no per-episode score, no spoiler flag,
// no word minimum). Stars are 1–10 in the UI; we store a format-agnostic
// scoreRaw (0–100) and mirror it locally for instant display.

async function anilistGetReview(
  media: ParsedMedia,
): Promise<{ rating: number | null; note: { text: string; spoiler: boolean } | null }> {
  try {
    const identity = await anilistResolve(media);
    if (!identity) return { rating: null, note: null };
    const scoreRaw = (await anilistRatings.getValue())[identity.id];
    const noteText = (await anilistNotes.getValue())[identity.id];
    return {
      rating: scoreRaw === undefined ? null : Math.round(scoreRaw / 10),
      note: noteText ? { text: noteText, spoiler: false } : null,
    };
  } catch {
    return { rating: null, note: null };
  }
}

async function anilistRate(
  media: ParsedMedia,
  rating: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const identity = await anilistResolve(media);
    if (!identity) return { ok: false, error: "not found on AniList" };
    const scoreRaw = Math.max(0, Math.min(100, Math.round(rating * 10)));
    const out = await anilistSaveRating(identity.id, scoreRaw);
    if (!out.ok) return { ok: false, error: out.error ?? "rating failed" };
    const all = await anilistRatings.getValue();
    all[identity.id] = scoreRaw;
    await anilistRatings.setValue(all);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof AniListNotConnectedError ? "Not connected to AniList" : errMsg(e),
    };
  }
}

async function anilistUnrate(media: ParsedMedia): Promise<{ ok: boolean; error?: string }> {
  try {
    const identity = await anilistResolve(media);
    if (!identity) return { ok: false, error: "not found on AniList" };
    const out = await anilistSaveRating(identity.id, 0);
    if (!out.ok) return { ok: false, error: out.error ?? "failed" };
    const all = await anilistRatings.getValue();
    delete all[identity.id];
    await anilistRatings.setValue(all);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof AniListNotConnectedError ? "Not connected to AniList" : errMsg(e),
    };
  }
}

async function anilistSaveNote(
  media: ParsedMedia,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Note is empty" };
    const identity = await anilistResolve(media);
    if (!identity) return { ok: false, error: "not found on AniList" };
    const out = await anilistSaveNotes(identity.id, trimmed);
    if (!out.ok) return { ok: false, error: out.error ?? "note failed" };
    const all = await anilistNotes.getValue();
    all[identity.id] = trimmed;
    await anilistNotes.setValue(all);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof AniListNotConnectedError ? "Not connected to AniList" : errMsg(e),
    };
  }
}

async function anilistDeleteNote(media: ParsedMedia): Promise<{ ok: boolean; error?: string }> {
  try {
    const identity = await anilistResolve(media);
    if (!identity) return { ok: false, error: "not found on AniList" };
    const out = await anilistSaveNotes(identity.id, "");
    if (!out.ok) return { ok: false, error: out.error ?? "failed" };
    const all = await anilistNotes.getValue();
    delete all[identity.id];
    await anilistNotes.setValue(all);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof AniListNotConnectedError ? "Not connected to AniList" : errMsg(e),
    };
  }
}

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
 * Fetch + cache the CDN recipe list. Skips when the cache is fresh (unless
 * forced); uses an ETag for conditional refetches. Validates with parseRecipes
 * so a malformed list never lands in the cache. Best-effort: on any failure the
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
    // Fetch BOTH lists — the public Trakt list and the separate anime (AniList)
    // list — so contributed anime recipes reach the library too. They're kept in
    // separate files (CLAUDE.md) but merged into one effective remote list here.
    const [traktRes, animeRes] = await Promise.all([fetch(RECIPES.url), fetch(RECIPES.animeUrl)]);
    if (!traktRes.ok && !animeRes.ok) {
      return {
        ok: false,
        count: current?.recipes.length ?? 0,
        error: `HTTP ${traktRes.status}/${animeRes.status}`,
      };
    }
    const trakt = traktRes.ok
      ? parseLibrary((await traktRes.json()) as unknown)
      : { recipes: [], links: [] };
    const anime = animeRes.ok
      ? parseLibrary((await animeRes.json()) as unknown)
      : { recipes: [], links: [] };
    const recipes = [...trakt.recipes, ...anime.recipes];
    await remoteRecipes.setValue({ recipes, fetchedAt: Date.now() });
    await mergeLibraryLinks([...trakt.links, ...anime.links]);
    await graduateRecipes(recipes);
    return { ok: true, count: recipes.length };
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

/**
 * Migrate legacy per-recipe `links` (quick links used to live on the recipe)
 * into the standalone quickLinks store, deduped by name, then strip them from
 * the stored recipes. Idempotent: a no-op once recipes carry no `links`.
 */
async function migrateRecipeLinks(): Promise<void> {
  try {
    const stored = (await customRecipes.getValue()) as (Recipe & { links?: QuickLinkSite })[];
    const withLinks = stored.filter(
      (r) => r.links && (r.links.movie || r.links.tv || r.links.search),
    );
    if (withLinks.length === 0) return;

    const existing = await quickLinks.getValue();
    const seen = new Set(existing.map((s) => s.name));
    const additions: QuickLinkSite[] = [];
    for (const r of withLinks) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      const l = r.links as { movie?: string; tv?: string; search?: string };
      additions.push({
        id: `ql-${r.id}`,
        name: r.name,
        enabled: true,
        movie: l.movie,
        tv: l.tv,
        search: l.search,
      });
    }
    if (additions.length > 0) await quickLinks.setValue([...existing, ...additions]);

    // Strip `links` from every recipe so the migration doesn't run again.
    const cleaned = stored.map(({ links: _drop, ...rest }) => rest);
    await customRecipes.setValue(cleaned as Recipe[]);
  } catch {
    // best effort — a failed migration just leaves the old data in place
  }
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
 */
async function registerSite(origin: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const id = siteId(origin);
    const existing = await browser.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length === 0) await registerScript(origin);
    const list = await enabledOrigins.getValue();
    if (!list.includes(origin)) await enabledOrigins.setValue([...list, origin]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
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
