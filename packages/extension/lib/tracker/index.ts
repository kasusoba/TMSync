import type { ParsedMedia } from "@tmsync/shared";
import { anilistAdapter } from "../anilist/adapter";
import { traktAdapter } from "../trakt/adapter";
import type { TrackerAdapter } from "./adapter";
import { ALL_TRACKERS, type Tracker, isSeasonless } from "./types";

export type { TrackerAdapter } from "./adapter";
export type { RatingLevel, RecordPhase, RecordResult, Tracker, TrackedItem } from "./types";
export {
  ALL_TRACKERS,
  TRACKER_INFO,
  isSeasonless,
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
};

/** The adapter for a tracker. */
export function getAdapter(tracker: Tracker): TrackerAdapter {
  return ADAPTERS[tracker];
}

/**
 * The tracker an item actually routes to, decided by TYPE (constraint #1):
 * movies — anime or not — always go to Trakt, even on an `anilist` (anime) site,
 * which has no movie scrobble path. Series follow the recipe's tracker. This lets
 * one `mediaType: "auto"` recipe on a mixed anime site (where movie & series pages
 * are indistinguishable by URL/DOM) send series → AniList and movies → Trakt,
 * keyed off whether an episode was scraped.
 */
export function routeTracker(tracker: Tracker, mediaType: ParsedMedia["mediaType"]): Tracker {
  return mediaType === "movie" ? "trakt" : tracker;
}

/**
 * The NATIVE tracker for scraped media (multi-track — docs/MULTI-TRACK.md): the one
 * whose numbering the page ALREADY speaks, so it's recorded directly; every other
 * enabled tracker is DERIVED via the anime-map crosswalk. Inferred, NOT user-picked:
 * a page id in a tracker's `resolvableNamespaces` (or western seasoning — a season)
 * ⇒ that tracker; a bare linear episode (dedicated anime site) ⇒ AniList. Trakt is
 * checked first (its namespaces cover the general/TMDB case). When more trackers are
 * added, extend the ordered list below — the shared engine stays untouched.
 *
 * `enabled` (when given) constrains the choice to trackers the user actually turned
 * on. A DISABLED tracker can't be the "recorded directly" native one — e.g. an
 * AniList-only recipe on a TMDB/seasoned site (Trakt off) must record AniList
 * DIRECTLY with the scraped episode, not shove it through the crosswalk. Without
 * this, native=Trakt (off) forced AniList onto the derived path and it failed to
 * resolve. Omit `enabled` for a pure field-based answer (e.g. tests, pre-resolve).
 */
export function inferNativeTracker(media: ParsedMedia, enabled?: Tracker[]): Tracker {
  const candidates = ALL_TRACKERS.filter((tk) => !enabled || enabled.includes(tk));
  const speaks = (tk: Tracker) =>
    getAdapter(tk).resolvableNamespaces.some((ns) => media.ids?.[ns] !== undefined);
  // 1) A tracker whose id namespace the page carries speaks it natively (exact) —
  //    tmdb/imdb ⇒ Trakt, anilist/mal ⇒ AniList. First match in tracker order wins.
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
