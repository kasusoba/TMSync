import type { ParsedMedia } from "@tmsync/shared";
import type { TrackerAdapter } from "./adapter";
import { anilistAdapter } from "./anilist/adapter";
import { malAdapter } from "./mal/adapter";
import { simklAdapter } from "./simkl/adapter";
import { traktAdapter } from "./trakt/adapter";
import { ALL_TRACKERS, type Tracker, isPassthrough, isSeasonless, trackerFamily } from "./types";
import { wetrakrAdapter } from "./wetrakr/adapter";

export type { TrackerAdapter } from "./adapter";
export type {
  NumberingFamily,
  RatingLevel,
  RecordPhase,
  RecordResult,
  Tracker,
  TrackedItem,
} from "./types";
export {
  ALL_TRACKERS,
  TRACKER_INFO,
  isPassthrough,
  isSeasonless,
  trackerFamily,
  trackerLabel,
} from "./types";

/**
 * The adapter registry — routing's single source of truth (constraint #1). A map,
 * NOT a `=== "anilist" ? … : trakt` ternary: an unknown/added tracker must never
 * silently fall through to Trakt. Adding a tracker = one entry here.
 */
const ADAPTERS: Record<Tracker, TrackerAdapter> = {
  trakt: traktAdapter,
  anilist: anilistAdapter,
  mal: malAdapter,
  simkl: simklAdapter,
  wetrakr: wetrakrAdapter,
};

/** The adapter for a tracker. */
export function getAdapter(tracker: Tracker): TrackerAdapter {
  return ADAPTERS[tracker];
}

/**
 * The enabled trackers the user is connected to, in `enabled` order. Each tracker
 * stands on its own (constraint #1): a tracker the user never connected is never
 * called and never anchors the others, so a MAL-only user does not depend on Trakt
 * being up. When none is connected, all of `enabled` come back, so the badge can
 * still show a match and say "connect".
 */
export async function connectedTrackers(enabled: Tracker[]): Promise<Tracker[]> {
  const on: Tracker[] = [];
  for (const tk of enabled) {
    if (
      await getAdapter(tk)
        .isConnected()
        .catch(() => false)
    )
      on.push(tk);
  }
  return on.length ? on : enabled;
}

/**
 * The NATIVE tracker for scraped media (multi-track, docs/ARCHITECTURE.md): the one
 * whose numbering the page ALREADY speaks, so it's recorded directly; every other
 * enabled tracker is DERIVED (the crosswalk across families, ids within one, the
 * page as is for Simkl). Inferred, NOT user-picked: a page id in a tracker's
 * `resolvableNamespaces` (or western seasoning, a season) ⇒ that tracker; a bare
 * linear episode (dedicated anime site) ⇒ the first enabled cour tracker. Trackers
 * are checked in `TRACKER_INFO` order, so Trakt first (its namespaces cover the
 * general/TMDB case). A passthrough tracker (Simkl) is native only when it stands
 * alone. A new tracker needs no change here: the shared engine stays untouched.
 *
 * `enabled` (when given and not empty) limits the choice to the trackers the user
 * turned on, so the result is ALWAYS one of them: an AniList-only recipe on a
 * TMDB/seasoned site (Trakt off) records AniList directly with the scraped episode.
 * Omit `enabled` for a pure field-based answer (e.g. tests, pre-resolve).
 */
export function inferNativeTracker(media: ParsedMedia, enabled?: Tracker[]): Tracker {
  const allowed = enabled?.length
    ? ALL_TRACKERS.filter((tk) => enabled.includes(tk))
    : ALL_TRACKERS;
  // A passthrough tracker (Simkl) takes whatever numbering the page has, so it is
  // never the anchor others derive from. It is native only when it stands alone.
  const anchors = allowed.filter((tk) => !isPassthrough(tk));
  const candidates = anchors.length ? anchors : allowed;
  const speaks = (tk: Tracker) =>
    getAdapter(tk).resolvableNamespaces.some((ns) => media.ids?.[ns] !== undefined);
  // 1) A tracker whose id namespace the page carries speaks it natively (exact) —
  //    tmdb/imdb ⇒ Trakt, anilist/mal ⇒ AniList (MAL when AniList is off). First
  //    match in tracker order wins.
  const byId = candidates.find(speaks);
  if (byId) return byId;
  // 2) A scraped season implies seasoned numbering ⇒ the first enabled SEASONED tracker.
  if (media.season !== undefined) {
    const seasoned = candidates.find((tk) => !isSeasonless(tk));
    if (seasoned) return seasoned;
  }
  // 3) A bare linear episode (or nothing) ⇒ a SEASONLESS tracker, else the first
  //    allowed one. `allowed` is never empty, so there is no hardcoded default.
  return candidates.find(isSeasonless) ?? (candidates[0] as Tracker);
}

/**
 * Whether a tracker takes the page's numbering as scraped: its family is the one
 * the page speaks (the native tracker when every tracker is on), or it takes any
 * numbering (Simkl). When the anchor doesn't (a cour tracker on a TMDB page because
 * Trakt is not connected), the background resolves it through the crosswalk like a
 * derived tracker, so it gets the exact cour and its own episode.
 */
export function speaksPage(tracker: Tracker, media: ParsedMedia): boolean {
  const family = trackerFamily(tracker);
  return family === "any" || family === trackerFamily(inferNativeTracker(media));
}
