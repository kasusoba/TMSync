import type { ParsedMedia } from "@tmsync/shared";
import { anilistAdapter } from "../anilist/adapter";
import { traktAdapter } from "../trakt/adapter";
import type { TrackerAdapter } from "./adapter";
import type { Tracker } from "./types";

export type { TrackerAdapter } from "./adapter";
export type { RatingLevel, RecordPhase, RecordResult, Tracker, TrackedItem } from "./types";

/** The adapter for a tracker. Routing's single source of truth (constraint #1). */
export function getAdapter(tracker: Tracker): TrackerAdapter {
  return tracker === "anilist" ? anilistAdapter : traktAdapter;
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
 */
export function inferNativeTracker(media: ParsedMedia): Tracker {
  const speaks = (adapter: TrackerAdapter) =>
    adapter.resolvableNamespaces.some((ns) => media.ids?.[ns] !== undefined);
  if (speaks(traktAdapter) || media.season !== undefined) return "trakt";
  // Everything else (a bare linear episode on a dedicated anime site, or no id at
  // all) falls to AniList. When a third tracker is added, insert its `speaks()`
  // check above this line rather than after — the final return is the default.
  return "anilist";
}
