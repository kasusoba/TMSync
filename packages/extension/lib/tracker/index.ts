import type { ParsedMedia } from "@tmsync/shared";
import { anilistAdapter } from "../anilist/adapter";
import { malAdapter } from "../mal/adapter";
import { simklAdapter } from "../simkl/adapter";
import { traktAdapter } from "../trakt/adapter";
import type { TrackerAdapter } from "./adapter";
import { ALL_TRACKERS, type Tracker, isPassthrough, isSeasonless } from "./types";

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
};

/** The adapter for a tracker. */
export function getAdapter(tracker: Tracker): TrackerAdapter {
  return ADAPTERS[tracker];
}

/**
 * The tracker an item actually routes to, decided by TYPE (constraint #1). A cour
 * tracker (AniList, MAL) records series only, so a movie on a cour site goes to
 * Trakt. This lets one `mediaType: "auto"` recipe on a mixed anime site (where
 * movie and series pages look the same by URL/DOM) send series to the cour tracker
 * and movies to Trakt, keyed off whether an episode was scraped. A tracker that
 * takes movies (Trakt, Simkl) keeps them.
 */
export function routeTracker(tracker: Tracker, mediaType: ParsedMedia["mediaType"]): Tracker {
  return mediaType === "movie" && isSeasonless(tracker) ? "trakt" : tracker;
}

/**
 * The NATIVE tracker for scraped media (multi-track, docs/MULTI-TRACK.md): the one
 * whose numbering the page ALREADY speaks, so it's recorded directly; every other
 * enabled tracker is DERIVED (the crosswalk across families, ids within one, the
 * page as is for Simkl). Inferred, NOT user-picked: a page id in a tracker's
 * `resolvableNamespaces` (or western seasoning, a season) ⇒ that tracker; a bare
 * linear episode (dedicated anime site) ⇒ the first enabled cour tracker. Trackers
 * are checked in `TRACKER_INFO` order, so Trakt first (its namespaces cover the
 * general/TMDB case). A passthrough tracker (Simkl) is native only when it stands
 * alone. A new tracker needs no change here: the shared engine stays untouched.
 *
 * `enabled` (when given) constrains the choice to trackers the user actually turned
 * on. A DISABLED tracker can't be the "recorded directly" native one — e.g. an
 * AniList-only recipe on a TMDB/seasoned site (Trakt off) must record AniList
 * DIRECTLY with the scraped episode, not shove it through the crosswalk. Without
 * this, native=Trakt (off) forced AniList onto the derived path and it failed to
 * resolve. Omit `enabled` for a pure field-based answer (e.g. tests, pre-resolve).
 */
export function inferNativeTracker(media: ParsedMedia, enabled?: Tracker[]): Tracker {
  const allowed = ALL_TRACKERS.filter((tk) => !enabled || enabled.includes(tk));
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
  //    enabled (never a disabled one). No hardcoded "else ⇒ anilist".
  return candidates.find(isSeasonless) ?? candidates[0] ?? "anilist";
}
