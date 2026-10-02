import { ANIME_MAP } from "@/config";
import { CONTENT_MARK } from "@/lib/diagnostics/why";
import { errorMessage } from "@/lib/errors";
import { effectiveRecipes, loadRecipeState, loadRecipes } from "@/lib/recipes";
import {
  addedHosts,
  findMovedSite,
  forkBasesOf,
  groupSites,
  withSiteHosts,
} from "@/lib/recipes/sites";
import {
  type RefreshResult,
  applySourceLinks,
  migrateFromLibrary,
  refreshSources,
} from "@/lib/recipes/source-sync";
import { statusDotColor } from "@/lib/scrobble/action-badge";
import {
  animapOverrides,
  animeMap,
  customRecipes,
  enabledOrigins,
  episodeOverrides,
  forkBases,
  listSyncAuto,
  listSyncAutoSeen,
  listSyncSettings,
  manualContexts,
  manualSelections,
  newPendingSites,
  recipeSources,
  sealPlainSecrets,
  siteGrantIntent,
  siteSourcePins,
  sourceCaches,
  tabFrameOrigins,
  tabSessions,
  tabStatus,
} from "@/lib/storage";
import { startApply } from "@/lib/sync/apply";
import { AUTO_ALARM, runAuto, showAutoBadge, syncAutoAlarm } from "@/lib/sync/auto";
import { forgetLists } from "@/lib/sync/base-store";
import { startPreview } from "@/lib/sync/preview";
import {
  ALL_TRACKERS,
  connectedTrackers,
  getAdapter,
  inferNativeTracker,
  isPassthrough,
  isSeasonless,
  speaksPage,
  trackerFamily,
  trackerLabel,
} from "@/lib/trackers";
import {
  type AnimapOverrides,
  type DeriveOutcome,
  type TargetIds,
  deriveMediaWith,
} from "@/lib/trackers/animap/derive";
import type { Animap } from "@/lib/trackers/animap/index";
import { loadAnimap, parseAnimeMap } from "@/lib/trackers/animap/load";
import { planCourWrite } from "@/lib/trackers/cour-plan";
import {
  type ReviewHandler,
  allServices,
  connectTracker,
  getService,
  watchConnectGrants,
} from "@/lib/trackers/service";
import {
  TRACKER_INFO,
  type TrackedItem,
  type Tracker,
  WATCHED_THRESHOLD,
} from "@/lib/trackers/types";
import {
  type BadgeStatus,
  type DerivedOutcome,
  type ReviewTarget,
  type ScrobbleReply,
  type ScrobbleRequest,
  type SiteGrantOutcome,
  type TrackerResolution,
  type WatchStanding,
  onMessage,
  sendMessage,
} from "@/messaging";
import {
  type LibraryLink,
  type ParsedMedia,
  type Recipe,
  hostText,
  parseLibrary,
  primaryId,
  recipeHosts,
} from "@tmsync/shared";
import { browser } from "wxt/browser";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether the tab's episode already played past `WATCHED_THRESHOLD`, read from
 * the persisted session. Only the progress counts: a session also ends on an
 * early leave (tab close, navigation, video removed), so `ended` alone does not
 * mean watched. No session for this media (the prompt before play) means not
 * watched.
 */
async function episodeWatched(tabId: number | undefined, media: ParsedMedia): Promise<boolean> {
  if (tabId === undefined) return false;
  const session = (await tabSessions.getValue())[tabId];
  if (!session || !sameMedia(session.media, media)) return false;
  return session.progress >= WATCHED_THRESHOLD * 100;
}

/** Same watched item: title, numbering, and strongest id. */
function sameMedia(a: ParsedMedia, b: ParsedMedia): boolean {
  return (
    a.mediaType === b.mediaType &&
    a.title === b.title &&
    a.year === b.year &&
    a.season === b.season &&
    a.episode === b.episode &&
    primaryId(a)?.value === primaryId(b)?.value
  );
}
const siteId = (origin: string) => `tmsync-${origin.replace(/[^a-z0-9]/gi, "-")}`;

/** The broad optional grant (`optional_host_permissions`) + the single catch-all
 * content-script it backs. When the user opts into "enable all sites", one grant
 * covers every recipe origin, so we register ONE all-URLs (ALL_SITES) script
 * instead of per-origin ones — and any synced/imported/CDN recipe is live with no
 * further prompt. Kept mutually exclusive with the per-origin scripts (running both
 * would inject the content script twice into the same frame). */
const ALL_SITES = "*://*/*";
const ALL_SITES_ID = "tmsync-all-sites";
const hasAllSites = () => browser.permissions.contains({ origins: [ALL_SITES] });

/**
 * MV3 service worker. STATELESS (constraint #4): every handler reads from
 * storage; no session state, timers, or buffers held here.
 */
const OWNER_TTL_MS = 5 * 60 * 1000;

export default defineBackground(() => {
  // Dynamic content-script registrations are cleared on extension reload/update
  // (not browser restart). Re-establish them (broad catch-all, or per enabled
  // origin) so a plain "reload the extension" is enough and survives updates.
  void syncRegistrations();
  void customRecipes.migrate();
  void migrateFromLibrary();
  // Encrypt OAuth tokens stored before encryption existed (lib/secret.ts).
  void sealPlainSecrets();

  // Keep registrations in step with the recipe set: a recipe synced from another
  // device, imported, or pulled from a source auto-activates on any origin the user
  // already granted (or everywhere, under the broad grant), no manual re-enable.
  // These are event listeners re-established on each SW wake, not held state.
  // Also note the sites a change brings in, for the popup's one-line nudge.
  customRecipes.watch(async (next, prev) => {
    void syncRegistrations();
    const { sourced } = await loadRecipeState();
    const others = sourced.map((s) => s.recipe);
    await noteNewSites(addedHosts(prev ?? [], next ?? [], others));
  });
  // A refresh of a source the user already had can bring new sites. The first
  // copy of a new source is the user's own doing, not news, so it is skipped.
  sourceCaches.watch(async (next, prev) => {
    void syncRegistrations();
    const before = prev ?? {};
    const custom = await customRecipes.getValue();
    for (const [id, cache] of Object.entries(next ?? {})) {
      const old = before[id];
      if (!old) continue;
      const others = [
        ...custom,
        ...Object.entries(next ?? {})
          .filter(([other]) => other !== id)
          .flatMap(([, c]) => c.recipes),
      ];
      await noteNewSites(addedHosts(old.recipes, cache.recipes, others));
    }
  });
  // Adding, removing, reordering, or turning off a source, or pinning a site,
  // changes which recipes and quick links apply. Fetching stays with the refresh
  // message and the alarm, so this never fetches twice.
  recipeSources.watch(async (next) => {
    const ids = new Set((next ?? []).map((s) => s.id));
    const caches = await sourceCaches.getValue();
    const kept = Object.fromEntries(Object.entries(caches).filter(([id]) => ids.has(id)));
    if (Object.keys(kept).length !== Object.keys(caches).length) {
      await sourceCaches.setValue(kept);
    }
    void syncRegistrations();
    await applySourceLinks();
  });
  siteSourcePins.watch(() => void applySourceLinks());
  forkBases.watch(() => void syncRegistrations());

  // Refresh the sources on startup + a periodic alarm (the SW is ephemeral, so we
  // can't hold a timer, constraint #4).
  void refreshSources();
  // The anime-map crosswalk rides the same pattern (fetched, never bundled), on its
  // own daily alarm. Upstream regenerates weekly.
  void fetchAnimeMap();
  browser.alarms.create("tmsync-recipes", { periodInMinutes: 720 });
  browser.alarms.create("tmsync-anime-map", { periodInMinutes: 1440 });
  // Automatic list sync: an alarm only while the user has it on, and the toolbar
  // count of what waits for review. Both follow storage, so the options page just
  // saves the setting.
  void syncAutoAlarm();
  void showAutoBadge();
  listSyncSettings.watch(() => {
    void syncAutoAlarm();
    void showAutoBadge();
  });
  listSyncAuto.watch(() => void showAutoBadge());
  listSyncAutoSeen.watch(() => void showAutoBadge());
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "tmsync-recipes") void refreshSources({ force: true });
    if (alarm.name === "tmsync-anime-map") void fetchAnimeMap(true);
    if (alarm.name === AUTO_ALARM) void runAuto();
    for (const service of allServices()) void service.alarms?.[alarm.name]?.();
  });

  // A site grant from the popup. If the prompt closed the popup, nothing asks us
  // to finish it, so finish it here. Wait a moment first: a popup that is still
  // open asks right away and shows the result.
  browser.permissions.onAdded.addListener(async (granted) => {
    const intent = await siteGrantIntent.getValue();
    if (!intent || !granted.origins?.includes(`${intent.origin}/*`)) return;
    await sleep(SITE_GRANT_WAIT_MS);
    await finishSiteGrant();
  });

  // Each tracker's own listeners, set up again on each wake (constraint #4).
  for (const service of allServices()) service.onWake?.();
  watchConnectGrants();

  onMessage("refreshRecipes", async ({ data }): Promise<RefreshResult> => {
    // One source (just added or turned on), or every source plus the anime map
    // (the Refresh button). Awaited so the options page reads fresh caches after.
    if (data?.sourceId) return refreshSources({ onlyId: data.sourceId });
    const [out] = await Promise.all([refreshSources({ force: true }), fetchAnimeMap(true)]);
    return out;
  });

  onMessage("ping", () => "pong" as const);

  // Accounts: one set of handlers for every tracker, through its service.
  onMessage("getTrackerStatus", ({ data }) => getService(data).status());

  onMessage("connectTracker", async ({ data }) => {
    try {
      await connectTracker(data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });

  onMessage("disconnectTracker", async ({ data }) => {
    await forgetLists(data);
    await getService(data).disconnect();
  });

  // List sync: a preview job reads and plans; an apply job writes that plan.
  onMessage("listSyncStart", () => startPreview());
  onMessage("listSyncApply", () => startApply());

  // A frame reports a video event; route to the recipe's tracker adapter, resolve
  // identity (cached) and record progress. The scrobble trackers (Trakt, Simkl) and
  // the list trackers (AniList, MAL, one threshold write) differ entirely. That
  // lives behind the adapter; this handler is tracker-agnostic.
  onMessage("scrobble", async ({ data, sender }) => {
    // Only one frame records per tab (page + player iframe would otherwise both
    // fire start/pause/stop for the same item → Trakt rejects out-of-order).
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    if (tabId !== undefined && !(await claimScrobbleOwner(tabId, frameId, data.action))) {
      return { ok: true, resolved: true }; // another frame owns this tab's scrobble
    }
    // A tracker that must wait before a stop (Simkl's lock) is recorded after this
    // reply, so the badge shows the others now; its outcome follows to this frame.
    return recordScrobble(data, (late) => {
      void late.then(
        (outcomes) => {
          if (tabId === undefined) return;
          void sendMessage(
            "scrobbleFollowUp",
            { media: data.media, outcomes },
            { tabId, frameId },
          ).catch(() => {}); // the tab closed: the watch is recorded anyway
        },
        () => {},
      ); // each tracker folds its own errors into its outcome
    });
  });

  // Pre-resolution for the badge: resolve identity (cached) without recording so
  // the user sees the matched tracker title before play. It asks the primary
  // tracker among the CONNECTED ones, so a tracker the user never connected is not
  // called. With none connected, Trakt and AniList still read without a login, so
  // the badge shows a match before Connect. MAL needs its site access, and Simkl
  // never searches, so they may show no match until connected or written.
  onMessage("resolveMedia", async ({ data }) => {
    const tracker = inferNativeTracker(data.media, await connectedTrackers(data.trackers));
    const adapter = getAdapter(tracker);
    try {
      const { item } = await resolveNative(
        tracker,
        data.media,
        await animapOverrides.getValue(),
        await loadAnimap(),
      );
      if (!item) return { tracker, resolved: false };
      return {
        tracker,
        resolved: true,
        id: item.id,
        title: item.title,
        year: item.year,
        mediaType: item.mediaType,
      };
    } catch {
      // A tracker that can't read without its connection (MAL without site access)
      // fails here. Say "connect", not "not found".
      const connected = await adapter.isConnected().catch(() => true);
      return connected
        ? { tracker, resolved: false }
        : { tracker, resolved: false, reason: "not_connected" as const };
    }
  });

  // MULTI-TRACK: per-tracker destination readout for the rate/correction UI.
  onMessage("resolveAll", async ({ data }) => {
    const { trackers } = data;
    if (!trackers.length) return [];
    // Only the connected trackers are asked. The others get a "not connected" row,
    // in the recipe's order, so the panel still lists every enabled tracker.
    const connected = await connectedTrackers(trackers);
    const offline = (tracker: Tracker): TrackerResolution => ({
      tracker,
      resolved: false,
      reason: "not_connected",
    });
    try {
      const rows = await resolveAcross(
        data.media,
        connected,
        await animapOverrides.getValue(),
        await loadAnimap(),
      );
      return trackers.map((tk) => rows.find((r) => r.tracker === tk) ?? offline(tk));
    } catch {
      return trackers.map((tracker) =>
        connected.includes(tracker)
          ? { tracker, resolved: false, reason: "http" }
          : offline(tracker),
      );
    }
  });

  onMessage("registerSite", ({ data }) => registerSite(data));
  onMessage("finishSiteGrant", () => finishSiteGrant());
  onMessage("unregisterSite", ({ data }) => unregisterSite(data));
  onMessage("startOnTab", ({ sender }) =>
    sender.tab?.id !== undefined ? startOnTab(sender.tab.id) : false,
  );
  onMessage("listEnabledSites", () => enabledOrigins.getValue());
  // Reconcile after a broad-grant toggle or a backup import (the caller changed
  // permissions/recipes in its own page context, then asks the SW to catch up).
  onMessage("syncSiteRegistrations", () => syncRegistrations());
  onMessage("pendingSites", () => pendingSites());
  onMessage("hasAllSitesGrant", () => hasAllSites());

  // --- manual mode (sites with no readable title) ---
  onMessage("getManualMedia", async ({ data }) => {
    const all = await manualSelections.getValue();
    return all[`${data.recipeId}::${data.pageKey}`] ?? null;
  });

  onMessage("setManualMedia", async ({ data, sender }) => {
    // Lock resolution to the exact entry the user picked, so re-searching the title
    // can't drift to a remake or a wrong year later. The pick's own ids do this for
    // most trackers; one that needs more keeps its own lock (`pinPick`).
    await getService(data.pick.tracker).pinPick?.(data.media, data.pick);
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
    const prev = all[tabId];
    if (
      prev?.recipeId === data.recipeId &&
      prev.pageKey === data.pageKey &&
      prev.trackers?.join() === data.trackers.join()
    ) {
      return;
    }
    all[tabId] = data;
    await manualContexts.setValue(all);
  });

  onMessage("getManualContext", async ({ data, sender }) => {
    const tabId = data?.tabId ?? sender.tab?.id;
    if (tabId === undefined) return null;
    return (await manualContexts.getValue())[tabId] ?? null;
  });

  onMessage("openOptions", () => browser.runtime.openOptionsPage());

  onMessage("manualSearchers", async ({ data }) => {
    const searchable = ALL_TRACKERS.filter((tk) => !!getService(tk).search);
    const usable = (await connectedTrackers(data.trackers)).filter((tk) => searchable.includes(tk));
    return { usable, searchable };
  });

  onMessage("searchTracker", async ({ data }) => {
    try {
      return (await getService(data.tracker).search?.(data.query, data.type)) ?? [];
    } catch {
      return [];
    }
  });

  onMessage("exportLetterboxd", async ({ data }) => {
    const run = getService(data.tracker).exportLetterboxd;
    if (!run) return { ok: false, error: `${TRACKER_INFO[data.tracker].label} has no export` };
    try {
      const { csv, count } = await run();
      return { ok: true, csv, count };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });

  // Pin the fix on the media this tracker resolves, not the page as scraped: a
  // derived tracker gets the crosswalk's media (Trakt, WeTrakr from an AniList
  // page) or the page plus the native item's ids (Simkl), so a pin on the page
  // would never be read.
  onMessage("fixMatch", async ({ data, sender }) => {
    const tabId = data.tabId ?? sender.tab?.id;
    const trackers =
      tabId !== undefined ? (await tabSessions.getValue())[tabId]?.trackers : undefined;
    const target = await reviewTarget({ media: data.media, tracker: data.tracker, trackers });
    const media = "media" in target ? target.media : data.media;
    await getService(data.tracker).pinPick?.(media, data.pick);
    if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
  });

  onMessage("searchCour", async ({ data }) => {
    try {
      return await getService(data.tracker).pins.search(data.query);
    } catch {
      return [];
    }
  });

  // Pin/block a cour tracker's entry, a local override above Fribb. It writes both
  // keys: a tmdb id keys a crosswalk pin (the tracker derived), and the title key
  // pins the match when the tracker resolves the page itself (native, which can
  // happen with a tmdb id too, e.g. Trakt off) or follows AniList (MAL). The title
  // key carries the season, so a pin for one season never applies to another.
  onMessage("setCourMatch", async ({ data, sender }) => {
    const out = await getService(data.tracker).pins.apply(data.media, data.id);
    if (!out.ok) {
      return { ok: false, error: `couldn't load that ${trackerLabel(data.tracker)} entry` };
    }
    const tabId = data.tabId ?? sender.tab?.id;
    if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
    return { ok: true };
  });

  // Undo a pin (or a "Not on <tracker>") → back to the automatic match (the Fribb
  // crosswalk, or the title search). Clears both keys, like the set.
  onMessage("resetCourMatch", async ({ data, sender }) => {
    await getService(data.tracker).pins.apply(data.media, undefined);
    const tabId = data.tabId ?? sender.tab?.id;
    if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
    return { ok: true };
  });

  // The user confirmed a rewatch of a completed cour entry → write the rewatch
  // (or re-complete + bump the rewatch count on the final episode) on every tracker
  // that asked, then update the badge. A derived tracker confirms the crosswalk's
  // entry (via reviewTarget), the same one the scrobble wrote to.
  onMessage("confirmRewatch", async ({ data, sender }) => {
    const asked = data.trackers;
    const enabled = data.enabled.length ? data.enabled : asked;
    const tabId = data.tabId ?? sender.tab?.id;
    const watched = await episodeWatched(tabId, data.media);
    const done: { name: string; title: string; completed: boolean }[] = [];
    const errors: string[] = [];
    for (const tracker of asked) {
      const name = trackerLabel(tracker);
      try {
        const adapter = getAdapter(tracker);
        const target = await reviewTarget({ media: data.media, tracker, trackers: enabled });
        if ("error" in target) {
          errors.push(target.error);
          continue;
        }
        const item = await resolveDerived(tracker, target); // the entry the scrobble wrote to
        if (!item || !adapter.confirmRewatch) {
          errors.push(`not found on ${name}`);
          continue;
        }
        const result = await adapter.confirmRewatch(item, target.media, watched);
        if (!result.ok) {
          errors.push(
            result.reason === "not_connected"
              ? `Not connected to ${name}`
              : (result.httpError ?? `${name} failed`),
          );
          continue;
        }
        done.push({ name, title: item.title, completed: result.completed === true });
      } catch (e) {
        errors.push(errorMessage(e));
      }
    }
    const first = done[0];
    if (!first) return { ok: false, error: errors.join(" · ") || "rewatch failed" };
    // Reflect it on the badge (and gate the rating prompt on completion).
    const completed = done.every((d) => d.completed);
    if (tabId !== undefined) {
      const ep = data.media.episode;
      const names = done.map((d) => d.name).join(" and ");
      void sendMessage(
        "scrobbleStatus",
        {
          // Not watched yet: the rewatch started, and this episode counts at its stop.
          state: watched ? "scrobbled" : "idle",
          title: `${first.title}${ep !== undefined ? ` E${ep}` : ""}`,
          detail: completed ? `rewatch complete on ${names}` : `rewatching on ${names}`,
          completed,
        },
        { tabId, frameId: 0 },
      ).catch(() => {});
    }
    return errors.length
      ? { ok: false, error: errors.join(" · "), completed }
      : { ok: true, completed };
  });

  // --- ratings & notes (routed per tracker through its service) ---
  // Which affordances the badge should render for the routed tracker (the adapter's
  // levels), plus the user's own score scale where the tracker has one.
  onMessage("getRatingMeta", async ({ data }) => {
    const adapter = getAdapter(data.tracker);
    const levels = adapter.ratingLevels(data.media);
    const scoreFormat = await adapter.scoreFormat?.();
    return scoreFormat ? { levels, scoreFormat } : { levels };
  });

  // Rating + notes route through each tracker's service (`review`), never a switch
  // on the tracker name. Rating and note semantics differ per tracker, and each
  // handler uses only the params it needs.
  onMessage("getReview", async ({ data }) => {
    const t = await reviewTarget(data);
    return "error" in t ? { rating: null, note: null } : t.review.getReview(t.media, data.level);
  });
  onMessage("rateItem", async ({ data }) => {
    const t = await reviewTarget(data);
    return "error" in t ? t : t.review.rate(t.media, data.level, data.rating);
  });
  onMessage("unrateItem", async ({ data }) => {
    const t = await reviewTarget(data);
    return "error" in t ? t : t.review.unrate(t.media, data.level);
  });
  onMessage("saveNote", async ({ data }) => {
    const t = await reviewTarget(data);
    return "error" in t ? t : t.review.saveNote(t.media, data.level, data.text, data.spoiler);
  });
  onMessage("deleteNote", async ({ data }) => {
    const t = await reviewTarget(data);
    return "error" in t ? t : t.review.deleteNote(t.media, data.level);
  });

  // --- per-tab session coordination ---
  onMessage("publishMedia", async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    // The primary tracker is decided here, where the connections are known: the
    // native one among the connected trackers (see `connectedTrackers`).
    const { trackers } = data;
    if (!trackers.length) return;
    const tracker = inferNativeTracker(data.media, await connectedTrackers(trackers));
    const all = await tabSessions.getValue();
    const prev = all[tabId];
    all[tabId] = {
      media: data.media,
      tracker,
      trackers,
      videoSelector: data.videoSelector,
      frame: data.frame,
      // Keep progress across a re-publish of the same item (recheck). Start fresh
      // for another item or after a finished one, else the next episode inherits the
      // last one's progress (a stray stop on tab close).
      progress: prev && !prev.ended && sameMedia(prev.media, data.media) ? prev.progress : 0,
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
        }
      : null;
  });

  onMessage("getWatchedState", async ({ data, sender }) => {
    const tabId = data?.tabId ?? sender.tab?.id;
    if (tabId === undefined) return null;
    const session = (await tabSessions.getValue())[tabId];
    if (!session) return null;
    try {
      const enabled = session.trackers?.length ? session.trackers : [session.tracker];
      const tracker = inferNativeTracker(session.media, await connectedTrackers(enabled));
      const adapter = getAdapter(tracker);
      const { item } = await resolveNative(
        tracker,
        session.media,
        await animapOverrides.getValue(),
        await loadAnimap(),
      );
      if (!item) return null;
      return await adapter.watchedState(item);
    } catch {
      return null; // reads degrade quietly — the popup just omits the line
    }
  });

  // Pre-play standing per enabled tracker. Only cour trackers can be "already
  // watched" (Trakt records another play), so only they are checked. A derived one
  // is read on the crosswalk's entry, with its own episode number.
  onMessage("getWatchStanding", async ({ data, sender }) => {
    const tabId = data?.tabId ?? sender.tab?.id;
    if (tabId === undefined) return [];
    const session = (await tabSessions.getValue())[tabId];
    if (!session) return [];
    const enabled = await connectedTrackers(
      session.trackers?.length ? session.trackers : [session.tracker],
    );
    const out: WatchStanding[] = [];
    for (const tracker of enabled.filter(isSeasonless)) {
      try {
        const target = await reviewTarget({ media: session.media, tracker, trackers: enabled });
        if ("error" in target) continue;
        const episode = target.media.episode;
        const adapter = getAdapter(tracker);
        const item = await resolveDerived(tracker, target); // the entry the scrobble wrote to
        const w = item ? await adapter.watchedState(item) : null;
        if (!w || episode === undefined) continue;
        // The planner the write uses: "already" exactly when playing writes nothing
        // (counted, or a completed entry that asks first). An on-hold entry at a
        // later episode still writes (it goes back to watching), so it is not "already".
        const plan = planCourWrite({
          phase: "stop",
          progress: 100,
          watchedThreshold: 0,
          episode,
          total: w.total,
          entry: w.entry ?? null,
          rewatchConfirmed: false,
        });
        out.push({
          tracker,
          already: plan.kind === "already_watched" || plan.kind === "needs_rewatch",
          atEpisode: w.watchedCount,
          completed: w.completed === true,
        });
      } catch {
        // a read that fails just leaves this tracker out (the badge stays neutral)
      }
    }
    return out;
  });

  onMessage("updateProgress", async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const all = await tabSessions.getValue();
    const session = all[tabId];
    if (!session) return;
    // After the stop, a seek back must not lower the progress the stop recorded.
    const progress = session.ended ? Math.max(session.progress, data) : data;
    all[tabId] = { ...session, progress, updatedAt: Date.now() };
    await tabSessions.setValue(all);
  });

  onMessage("endSession", async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    // Don't drop the record — the item just finished, and the popup/badge should
    // still offer rate + fix on it. Mark it ended so the tab-close reconcile skips
    // it (the stop already fired). A fresh play (publishMedia) overwrites it; a real
    // nav-away (stopTabSession) still clears it.
    const all = await tabSessions.getValue();
    const session = all[tabId];
    // On an SPA episode swap the outgoing episode's stop lands after the next one
    // was published. It must not mark the new session ended.
    if (!session || !sameMedia(session.media, data.media)) return;
    // Keep the stop's progress: the throttled updates can lag behind it, and the
    // "Rewatching?" confirm reads it (episodeWatched).
    all[tabId] = { ...session, progress: data.progress, ended: true, updatedAt: Date.now() };
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
      // The same fan-out as a live stop: every enabled tracker, native or derived.
      // For Trakt this sends the final /scrobble/stop; for AniList it commits the
      // threshold write if the last progress crossed it (otherwise a quiet no-op).
      await recordScrobble({
        action: "stop",
        media: session.media,
        progress: session.progress,
        tracker: session.tracker,
        trackers: session.trackers,
      });
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
 * Record one scrobble phase on every enabled tracker: the native one directly, the
 * others through the crosswalk. Used by live scrobbles and by the tab-close stop.
 */
async function recordScrobble(
  data: ScrobbleRequest,
  /** Given, a stop records trackers that would wait (`stopDelayMs`) after the
   * reply and hands their outcomes here. Without it (the tab-close stop) every
   * tracker is recorded before returning. */
  onLate?: (late: Promise<DerivedOutcome[]>) => void,
): Promise<ScrobbleReply> {
  // MULTI-TRACK: the enabled set + which tracker speaks the page's numbering
  // natively (recorded directly). Every OTHER enabled tracker is derived via the
  // crosswalk. `trackers` is authoritative; fall back to the legacy single field.
  // Only the CONNECTED trackers are called: one the user never connected is
  // reported as such and never used as the anchor for the others.
  const toggled = data.trackers?.length ? data.trackers : [data.tracker];
  const enabled = await connectedTrackers(toggled);
  const offline: DerivedOutcome[] = toggled
    .filter((tk) => !enabled.includes(tk))
    .map((tracker) => ({ tracker, ok: false, skipped: true, reason: "not_connected" }));
  // The native tracker is always an ENABLED one (inferNativeTracker picks from
  // `enabled`). So an AniList-only recipe on a TMDB/seasoned site records AniList
  // directly with the scraped episode instead of forcing it through the crosswalk.
  // With a tmdb id on the page, an anchor that doesn't speak its numbering goes
  // through the crosswalk instead (see `resolveNative`).
  const native = inferNativeTracker(data.media, enabled);
  const overrides = await animapOverrides.getValue();
  const animap = await loadAnimap();
  let anchor: NativeResolution = { item: null, media: data.media };
  let nativeError: string | undefined;
  try {
    anchor = await resolveNative(native, data.media, overrides, animap);
  } catch (e) {
    nativeError = errorMessage(e);
  }
  const nativeItem = anchor.item;
  const nativeReply = anchor.ambiguous
    ? {
        ok: false,
        resolved: false,
        reason: "numbering_mismatch" as const,
        primaryTracker: native,
      }
    : await recordNative(native, nativeItem, nativeError, { ...data, media: anchor.media });

  // Derive + record every OTHER enabled tracker via the crosswalk (+ overrides).
  // The native item is the anchor: a reverse (cour → seasoned) derive bridges from
  // its id. Passthrough trackers last: a Simkl stop may wait out its 20 s scrobble lock,
  // and the others are recorded in order, so they must not wait behind it.
  const others = enabled
    .filter((t) => t !== native)
    .sort((a, b) => Number(isPassthrough(a)) - Number(isPassthrough(b)));
  const late = onLate && data.action === "stop" ? await trackersThatWait(others) : [];
  const derived = await recordDerivedTrackers(
    nativeItem,
    others.filter((t) => !late.includes(t)),
    data,
    overrides,
    animap,
  );
  if (late.length && onLate) {
    onLate(recordDerivedTrackers(nativeItem, late, data, overrides, animap));
    derived.push(...late.map((tracker) => ({ tracker, ok: true, deferred: true })));
  }
  derived.push(...offline);
  return { ...nativeReply, derived: derived.length ? derived : undefined };
}

/** The anchor's entry and the media it records (the page's, or the crosswalk's). */
interface NativeResolution {
  item: TrackedItem | null;
  media: ParsedMedia;
  /** The crosswalk can't pin one entry: refuse, never guess. */
  ambiguous?: true;
}

/**
 * Resolve the anchor tracker. It takes the page as scraped when it speaks the
 * page's numbering. When it doesn't (a cour tracker on a TMDB page because the
 * seasoned tracker is not connected), the crosswalk maps it like a derived
 * tracker, so it gets the exact cour and its own episode. A crosswalk miss falls
 * back to the page as scraped (a title match, the guardrail still applies); an
 * ambiguous row is refused.
 */
async function resolveNative(
  native: Tracker,
  media: ParsedMedia,
  overrides: AnimapOverrides,
  animap: Animap,
): Promise<NativeResolution> {
  if (!speaksPage(native, media)) {
    const d = deriveMediaWith(native, media, null, overrides, animap);
    if (d.kind === "ambiguous") return { item: null, media, ambiguous: true };
    if (d.kind === "resolved") {
      const target = d.ids ? { ...d.media, ids: { ...d.media.ids, ...d.ids } } : d.media;
      return { item: await resolveDerived(native, d), media: target };
    }
  }
  return { item: await getAdapter(native).resolve(media), media };
}

/** Record the native tracker directly and shape the badge's primary reply. */
async function recordNative(
  native: Tracker,
  item: TrackedItem | null,
  error: string | undefined,
  data: ScrobbleRequest,
): Promise<ScrobbleReply> {
  if (error !== undefined) {
    // A tracker that can't even read while disconnected (MAL) says "connect", not "failed".
    if (!(await getAdapter(native).isConnected())) {
      return { ok: false, resolved: false, reason: "not_connected", primaryTracker: native };
    }
    return { ok: false, resolved: false, reason: "http", httpError: error, primaryTracker: native };
  }
  if (!item) return { ok: false, resolved: false, reason: "unresolved", primaryTracker: native };
  const result = await getAdapter(native).recordProgress(
    item,
    data.media,
    data.progress,
    data.action,
  );
  return {
    ok: result.ok,
    status: result.status,
    action: result.action,
    resolved: true,
    reason: result.ok ? undefined : result.reason,
    completed: result.completed,
    info: result.info,
    atEpisode: result.atEpisode,
    resolvedTitle: result.reason === "no_episode" ? undefined : item.title,
    resolvedYear: result.reason === "no_episode" ? undefined : item.year,
    resolvedEpisodes: "episodes" in item ? item.episodes : undefined,
    httpError: result.httpError,
    primaryTracker: native,
  };
}

/** The trackers that could not take a stop right now (Simkl inside its lock). */
async function trackersThatWait(trackers: Tracker[]): Promise<Tracker[]> {
  const out: Tracker[] = [];
  for (const tk of trackers) {
    const wait = await getAdapter(tk).stopDelayMs?.();
    if (wait) out.push(tk);
  }
  return out;
}

/**
 * Whether deriving `target` from `native` is a reverse derivation (cour →
 * seasoned), which bridges from the cour-native entry's id. Forward derivation
 * needs only the scraped tmdb id.
 */
function needsCourBridge(native: Tracker, target: Tracker): boolean {
  return trackerFamily(native) === "cour" && trackerFamily(target) === "seasoned";
}

/**
 * {@link deriveMediaWith}, plus one fallback: a seasoned tracker that speaks the
 * page resolves the page itself when the native tracker found nothing (WeTrakr
 * when Trakt has no such title), as it would if it were native.
 */
function deriveTarget(
  target: Tracker,
  media: ParsedMedia,
  nativeItem: TrackedItem | null,
  overrides: AnimapOverrides,
  animap: Animap,
): DeriveOutcome {
  const d = deriveMediaWith(target, media, nativeItem, overrides, animap);
  if (
    d.kind === "miss" &&
    nativeItem === null &&
    trackerFamily(target) === "seasoned" &&
    speaksPage(target, media)
  ) {
    return { kind: "resolved", media };
  }
  return d;
}

/**
 * Resolve a derived tracker's entry: by the exact ids the derivation named (the
 * adapter picks the namespace it can use), else from the derived media.
 */
function resolveDerived(
  tk: Tracker,
  d: { media: ParsedMedia; ids?: TargetIds },
): Promise<TrackedItem | null> {
  const adapter = getAdapter(tk);
  return d.ids && adapter.resolveById
    ? adapter.resolveById(d.ids, d.media)
    : adapter.resolve(d.media);
}

/** A resolved tracker's readout row. An id of 0 (Simkl before its first write)
 * is not an id yet, so the row links nowhere until the tracker names one. */
function resolvedRow(item: TrackedItem): TrackerResolution {
  return {
    tracker: item.tracker,
    resolved: true,
    title: item.title,
    id: item.id || undefined,
    url: "url" in item ? item.url : undefined,
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
  animap: Animap,
): Promise<TrackerResolution[]> {
  const native = inferNativeTracker(media, trackers); // always one of `trackers`
  const nativeItem = (
    await resolveNative(native, media, overrides, animap).catch(() => ({ item: null }))
  ).item;
  const out: TrackerResolution[] = [];
  for (const tk of trackers) {
    if (tk === native) {
      out.push(
        nativeItem
          ? resolvedRow(nativeItem)
          : { tracker: tk, resolved: false, reason: "unresolved" },
      );
      continue;
    }
    const d = deriveTarget(tk, media, nativeItem, overrides, animap);
    if (d.kind === "miss") {
      // An empty crosswalk means the CDN copy hasn't landed yet, not that the
      // item is unmapped, so say that instead of "not on this tracker".
      out.push({
        tracker: tk,
        resolved: false,
        reason: animap.size > 0 ? "no_match" : "map_loading",
      });
      continue;
    }
    if (d.kind === "ambiguous") {
      out.push({ tracker: tk, resolved: false, reason: "ambiguous" });
      continue;
    }
    try {
      const item = await resolveDerived(tk, d);
      out.push(item ? resolvedRow(item) : { tracker: tk, resolved: false, reason: "unresolved" });
    } catch {
      out.push({ tracker: tk, resolved: false, reason: "http" });
    }
  }
  return out;
}

/**
 * The rating/note handler and the media it acts on. A derived tracker rates the
 * crosswalk's entry, the same one the scrobble writes and `resolveAll` shows. A title
 * search would often pick another cour (e.g. season 1 for a season 2 page).
 */
async function reviewTarget(
  data: ReviewTarget,
): Promise<
  { review: ReviewHandler; media: ParsedMedia; ids?: TargetIds } | { ok: false; error: string }
> {
  const tracker = data.tracker;
  const review = getService(tracker).review;
  const enabled = await connectedTrackers(data.trackers?.length ? data.trackers : [tracker]);
  const native = inferNativeTracker(data.media, enabled);
  if (tracker === native && speaksPage(native, data.media)) return { review, media: data.media };
  // The native item bridges a reverse derive, a same-family sibling (AniList ⇄
  // MAL) takes its ids straight from it, and a passthrough tracker (Simkl) adds them.
  // An anchor that doesn't speak the page (see `resolveNative`) maps itself
  // through the crosswalk, with no item to bridge from.
  const bridges =
    tracker !== native &&
    (needsCourBridge(native, tracker) ||
      trackerFamily(native) === trackerFamily(tracker) ||
      trackerFamily(tracker) === "any");
  const overrides = await animapOverrides.getValue();
  const animap = await loadAnimap();
  const nativeItem = bridges
    ? (await resolveNative(native, data.media, overrides, animap).catch(() => ({ item: null })))
        .item
    : null;
  const d = deriveTarget(tracker, data.media, nativeItem, overrides, animap);
  const name = trackerLabel(tracker);
  if (d.kind === "ambiguous") return { ok: false, error: `can't tell which ${name} entry this is` };
  // The anchor falls back to the page as scraped, as it does when it records.
  if (d.kind === "miss" && tracker === native) return { review, media: data.media };
  if (d.kind === "miss") return { ok: false, error: `not found on ${name}` };
  const media = d.ids ? { ...d.media, ids: { ...d.media.ids, ...d.ids } } : d.media;
  return { review, media, ids: d.ids };
}

/**
 * MULTI-TRACK (docs/ARCHITECTURE.md): record the DERIVED tracker(s) for a scrobble,
 * alongside the native one. The native item is already resolved+recorded; for each
 * other toggled tracker we derive its numbering via the anime-map crosswalk, then
 * resolve + record it. Independent + advance-only (each adapter owns its own watched
 * decision + never-lower rule). Never guesses: a crosswalk miss is a silent skip
 * (the item isn't anime / isn't mapped), an ambiguous match refuses with a warning.
 */
async function recordDerivedTrackers(
  nativeItem: TrackedItem | null,
  targets: Tracker[],
  data: ScrobbleRequest,
  overrides: AnimapOverrides,
  animap: Animap,
): Promise<DerivedOutcome[]> {
  const out: DerivedOutcome[] = [];

  // Record a resolved item and shape its reply (year/episodes included so the badge
  // shows them).
  const record = async (
    target: Tracker,
    item: TrackedItem,
    media: ParsedMedia,
  ): Promise<DerivedOutcome> => {
    const r = await getAdapter(target).recordProgress(item, media, data.progress, data.action);
    return {
      tracker: target,
      ok: r.ok,
      action: r.action,
      reason: r.ok ? undefined : r.reason,
      completed: r.completed,
      info: r.info,
      httpError: r.httpError,
      resolvedTitle: item.title,
      resolvedYear: item.year,
      resolvedEpisodes: "episodes" in item ? (item.episodes ?? undefined) : undefined,
    };
  };

  for (const target of targets) {
    const d = deriveTarget(target, data.media, nativeItem, overrides, animap);
    if (d.kind === "miss") {
      // No crosswalk row: skip this tracker (the item is not mapped there).
      out.push({
        tracker: target,
        ok: false,
        skipped: true,
        reason: animap.size > 0 ? "no_match" : "map_loading",
      });
      continue;
    }
    if (d.kind === "ambiguous") {
      out.push({ tracker: target, ok: false, reason: "numbering_mismatch" });
      continue;
    }
    let item: TrackedItem | null;
    try {
      item = await resolveDerived(target, d);
    } catch (e) {
      out.push(
        (await getAdapter(target).isConnected())
          ? { tracker: target, ok: false, reason: "http", httpError: errorMessage(e) }
          : { tracker: target, ok: false, reason: "not_connected" },
      );
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

// MV3 (Chrome + Firefox 109+) expose `action`; Firefox MV2 uses `browserAction`.
const tabAction = browser.action ?? browser.browserAction;
const NO_TAB_TEXT = null as unknown as string;

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
  // Clear the tab's own text (null, not ""): an empty tab text would hide the
  // global one, the automatic list sync count. Chrome and Firefox both document
  // null as "back to the global text"; the typings only say string.
  void tabAction.setBadgeText({ tabId, text: NO_TAB_TEXT }).catch(() => {}); // retire the old text glyph
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
      void tabAction.setBadgeText({ tabId, text: dot ? "●" : NO_TAB_TEXT }).catch(() => {});
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
 * Fetch + cache the anime-map crosswalk from the CDN (multi-track). Same shape as
 * the recipe fetch: TTL-gated, `If-None-Match` conditional, validated before it
 * lands, best-effort (a failure leaves the previous copy in use). It is NOT
 * bundled, so until the first fetch succeeds the map is empty and every derived
 * lookup misses, so a derived tracker simply degrades to native-only.
 */
async function fetchAnimeMap(
  force = false,
): Promise<{ ok: boolean; rows: number; error?: string }> {
  try {
    const current = await animeMap.getValue();
    if (!force && current && Date.now() - current.fetchedAt < ANIME_MAP.refreshMs) {
      return { ok: true, rows: current.rows.length };
    }
    const res = await fetch(
      ANIME_MAP.url,
      current?.etag ? { headers: { "If-None-Match": current.etag } } : undefined,
    );
    if (res.status === 304 && current) {
      await animeMap.setValue({ ...current, fetchedAt: Date.now() });
      return { ok: true, rows: current.rows.length };
    }
    if (!res.ok) return { ok: false, rows: current?.rows.length ?? 0, error: `HTTP ${res.status}` };
    const { rows, generatedAt } = parseAnimeMap(await res.json());
    // An empty/garbage list would silently disable multi-track, so keep the old copy.
    if (!rows.length) return { ok: false, rows: current?.rows.length ?? 0, error: "empty list" };
    await animeMap.setValue({
      rows,
      fetchedAt: Date.now(),
      etag: res.headers.get("ETag") ?? undefined,
      generatedAt,
    });
    return { ok: true, rows: rows.length };
  } catch (e) {
    return { ok: false, rows: 0, error: errorMessage(e) };
  }
}

/**
 * Reconcile the set of registered content scripts against permissions + recipes.
 * The single source of truth for "what is injected where"; safe to call on startup,
 * on a recipe change (sync/import/CDN refresh), and after the broad-grant toggle.
 *
 *  - Broad grant held → desired = the ONE catch-all all-URLs script; every
 *    per-origin script is removed (avoids double-injection). All recipes go live
 *    everywhere with no per-origin bookkeeping — the "enable all sites" path.
 *  - Otherwise → per-origin: remove the catch-all, then adopt any recipe origin the
 *    user ALREADY granted (so a synced/imported recipe activates silently, no
 *    prompt) and ensure a script for every `enabledOrigins` entry.
 *
 * Best-effort throughout: a missing host permission just leaves that site off.
 */
async function syncRegistrations(): Promise<void> {
  try {
    const registered = await browser.scripting.getRegisteredContentScripts();
    const ids = new Set(registered.map((s) => s.id));
    if (await hasAllSites()) {
      // Only the per-site scripts: a tracker's own scripts (wetrakr-quicklinks) stay.
      const perOrigin = registered
        .map((s) => s.id)
        .filter((id) => id.startsWith("tmsync-") && id !== ALL_SITES_ID);
      if (perOrigin.length)
        await browser.scripting.unregisterContentScripts({ ids: perOrigin }).catch(() => {});
      if (!ids.has(ALL_SITES_ID)) await registerAllSites().catch(() => {});
      return;
    }
    if (ids.has(ALL_SITES_ID))
      await browser.scripting.unregisterContentScripts({ ids: [ALL_SITES_ID] }).catch(() => {});
    await adoptPermittedRecipeOrigins();
    for (const origin of await enabledOrigins.getValue()) {
      if (!ids.has(siteId(origin))) await registerScript(origin).catch(() => {});
    }
  } catch {
    // best effort — a missing host permission just means that site stays off
  }
}

/** Distinct origins a recipe could match: EVERY host in its scope, not just the
 * first, so a site that moved domain is enabled on its old and new hosts alike.
 * The effective recipes (custom + sources); `https` is assumed (streaming sites
 * are TLS). */
async function recipeOrigins(): Promise<string[]> {
  const hosts = new Set<string>();
  for (const r of await loadRecipes()) {
    for (const h of recipeHosts(r)) hosts.add(`https://${h}`);
  }
  return [...hosts];
}

/** Fold any recipe origin the user already holds permission for into
 * `enabledOrigins`, so a synced/imported/CDN recipe on an already-granted site
 * becomes active with no prompt. Only ADDS — never revokes. */
async function adoptPermittedRecipeOrigins(): Promise<void> {
  const enabled = new Set(await enabledOrigins.getValue());
  let changed = false;
  for (const origin of await recipeOrigins()) {
    if (enabled.has(origin)) continue;
    if (await browser.permissions.contains({ origins: [`${origin}/*`] })) {
      enabled.add(origin);
      changed = true;
    }
  }
  if (changed) await enabledOrigins.setValue([...enabled]);
}

/** Recipe origins the user has NOT allowed (nor holds broadly). The popup checks
 * it for sites a sync or import just added. Empty under the broad grant. */
async function pendingSites(): Promise<string[]> {
  if (await hasAllSites()) return [];
  const enabled = new Set(await enabledOrigins.getValue());
  const pending: string[] = [];
  for (const origin of await recipeOrigins()) {
    if (enabled.has(origin)) continue;
    if (await browser.permissions.contains({ origins: [`${origin}/*`] })) continue;
    pending.push(origin);
  }
  return pending;
}

/** Add the new hosts that still need access to the popup's "new sites" list. */
async function noteNewSites(hosts: string[]): Promise<void> {
  if (hosts.length === 0 || (await hasAllSites())) return;
  const enabled = new Set(await enabledOrigins.getValue());
  const fresh: string[] = [];
  for (const h of hosts) {
    const origin = `https://${h}`;
    if (enabled.has(origin)) continue;
    if (await browser.permissions.contains({ origins: [`${origin}/*`] })) continue;
    fresh.push(origin);
  }
  if (fresh.length === 0) return;
  const known = await newPendingSites.getValue();
  await newPendingSites.setValue([...new Set([...known, ...fresh])]);
}

/** Register the single catch-all content script backed by the broad grant. */
async function registerAllSites(): Promise<void> {
  await browser.scripting.registerContentScripts([
    {
      id: ALL_SITES_ID,
      matches: [ALL_SITES],
      js: ["content-scripts/content.js"],
      runAt: "document_idle",
      allFrames: true,
      persistAcrossSessions: true,
    },
  ]);
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
 * for the popup's enabled-state AND for syncRegistrations() — so it must NOT be
 * gated on the scripting call. Right after the permission prompt is accepted, the
 * new host permission often isn't visible to this service worker yet, so the first
 * registerContentScripts() can throw; that used to leave the origin unpersisted, so
 * the popup still showed "Enable" until a second click (a known bug). Now we persist,
 * then register best-effort with one retry, and syncRegistrations() covers any
 * remaining gap on the next wake (the popup also injects the current tab directly).
 */
async function registerSite(origin: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const list = await enabledOrigins.getValue();
    if (!list.includes(origin)) await enabledOrigins.setValue([...list, origin]);
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
  // Under the broad grant the catch-all script already covers this origin; adding a
  // per-origin script too would inject the content script twice into the same frame.
  // Record the origin (so it survives the broad grant being revoked) but skip it.
  if (await hasAllSites()) return { ok: true };
  await ensureRegistered(origin).catch(() => {});
  return { ok: true };
}

/**
 * Idempotently register the content script for an origin, tolerating the brief
 * post-grant window where the new host permission hasn't propagated to the SW yet:
 * one short retry, then leave it to syncRegistrations() on the next wake.
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

/** How long a popup's site-grant intent stays valid. */
const SITE_GRANT_TTL_MS = 2 * 60_000;
/** How long `permissions.onAdded` waits for a popup that is still open to finish. */
const SITE_GRANT_WAIT_MS = 1_500;

/**
 * Run the step after a site-access grant the popup asked for (`siteGrantIntent`),
 * so one click is always enough, also when the prompt closed the popup. The
 * intent is cleared first, so the popup and `permissions.onAdded` never both run it.
 */
async function finishSiteGrant(): Promise<SiteGrantOutcome> {
  const intent = await siteGrantIntent.getValue();
  if (!intent || Date.now() - intent.at > SITE_GRANT_TTL_MS) return { done: false, ok: true };
  await siteGrantIntent.setValue(null);
  const { action, origin, tabId, frameId } = intent;
  try {
    let siteName: string | undefined;
    if (action === "adopt") {
      // Written before the content script is injected, so it loads them.
      const url = (await browser.tabs.get(tabId)).url ?? "";
      const state = await loadRecipeState();
      const moved = findMovedSite(groupSites(effectiveRecipes(state)), url);
      if (!moved) return { done: true, ok: false, error: "This page no longer matches a site." };
      const host = hostText(new URL(origin).hostname);
      await forkBases.setValue({ ...state.bases, ...forkBasesOf(moved, state.custom) });
      await customRecipes.setValue(withSiteHosts(moved, [...moved.hosts, host], state.custom));
      siteName = moved.name;
    }
    const res = await registerSite(origin);
    if (!res.ok) return { done: true, ok: false, error: res.error };
    if (action === "setup" || action === "setupFrame") {
      const live = await injectWithRetry(() =>
        browser.scripting.executeScript({
          target: { tabId, ...(frameId !== undefined ? { frameIds: [frameId] } : {}) },
          files: ["/content-scripts/picker.js"],
        }),
      );
      return live
        ? { done: true, ok: true, live }
        : { done: true, ok: false, error: "The page did not let the picker in." };
    }
    // Under the broad grant the catch-all script already runs here (and reloads its
    // recipes on the write above); injecting it again would scrobble twice.
    const live =
      (await hasAllSites()) ||
      (await injectWithRetry(() =>
        browser.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["/content-scripts/content.js"],
        }),
      ));
    return { done: true, ok: true, live, siteName };
  } catch (e) {
    return { done: true, ok: false, error: errorMessage(e) };
  }
}

/**
 * Inject into the open tab now (a registration covers only later loads). Right
 * after a grant the new host permission can lag reaching the scripting API, so
 * retry once. False when it still fails (e.g. a restricted page): reload to start.
 */
/**
 * Start the content script in the frames of a tab that have access but do not run
 * it: a registration covers only later loads, so a site the picker just saved
 * would wait for a reload. The script marks itself (`CONTENT_MARK`), so a frame
 * that runs it already is left alone and never scrobbles twice. False when a
 * frame refused the script.
 */
async function startOnTab(tabId: number): Promise<boolean> {
  try {
    const probe = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (mark: string) => ({
        runs: !!(globalThis as unknown as Record<string, unknown>)[mark],
        origin: location.origin,
      }),
      args: [CONTENT_MARK],
    });
    // Only the enabled sites, as a reload would (another granted origin, like a
    // tracker's site, has no content script).
    const enabled = await enabledOrigins.getValue();
    const frameIds = probe
      .filter((r) => r.result && !r.result.runs && enabled.includes(r.result.origin))
      .map((r) => r.frameId);
    if (frameIds.length === 0) return true;
    return await injectWithRetry(() =>
      browser.scripting.executeScript({
        target: { tabId, frameIds },
        files: ["/content-scripts/content.js"],
      }),
    );
  } catch {
    return false;
  }
}

async function injectWithRetry(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch {
    await sleep(250);
    try {
      await run();
      return true;
    } catch {
      return false;
    }
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
