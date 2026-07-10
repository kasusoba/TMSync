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
 *
 * `enabled` (when given) constrains the choice to trackers the user actually turned
 * on. A DISABLED tracker can't be the "recorded directly" native one — e.g. an
 * AniList-only recipe on a TMDB/seasoned site (Trakt off) must record AniList
 * DIRECTLY with the scraped episode, not shove it through the crosswalk. Without
 * this, native=Trakt (off) forced AniList onto the derived path and it failed to
 * resolve. Omit `enabled` for a pure field-based answer (e.g. tests, pre-resolve).
 */
export function inferNativeTracker(media: ParsedMedia, enabled?: Tracker[]): Tracker {
  const on = (tk: Tracker) => !enabled || enabled.includes(tk);
  const speaks = (adapter: TrackerAdapter) =>
    adapter.resolvableNamespaces.some((ns) => media.ids?.[ns] !== undefined);
  if (on("trakt") && (speaks(traktAdapter) || media.season !== undefined)) return "trakt";
  // Everything else (a bare linear episode on a dedicated anime site, no id at all,
  // or Trakt disabled) falls to AniList. When a third tracker is added, insert its
  // `on() && speaks()` check above this line — the final return is the default.
  return "anilist";
}
