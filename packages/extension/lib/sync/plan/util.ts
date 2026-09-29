/** Small pure helpers the planner parts share. */
import type { CourStatus } from "../../trackers/cour-plan";
import { type Tracker, trackerFamily } from "../../trackers/types";
import { idKeys as baseKeys } from "../base";
import type {
  EntryState,
  EpisodeRef,
  ListEntry,
  ListSyncSettings,
  SyncIds,
  SyncKind,
} from "../types";
import type { CourEntry, SeasonedEntry } from "./context";

/** The kinds a tracker can take at all: a cour tracker holds only anime. Pure. */
export function syncKindsFor(tracker: Tracker): SyncKind[] {
  return trackerFamily(tracker) === "cour" ? ["anime"] : ["movie", "tv", "anime"];
}

/** Whether a tracker takes part in a kind, after the user's choice. Pure. */
export function takesKind(tracker: Tracker, kind: SyncKind, settings: ListSyncSettings): boolean {
  if (!syncKindsFor(tracker).includes(kind)) return false;
  return (settings.kinds[tracker] ?? syncKindsFor(tracker)).includes(kind);
}

/**
 * Whether sync may remove a tracker's list entry. A seasoned tracker's list IS its
 * watch history (Trakt), and deleting plays cannot be undone, so it never is. Pure.
 */
export function removesEntries(tracker: Tracker): boolean {
  return trackerFamily(tracker) !== "seasoned";
}

/**
 * Whether a tracker can be a kind's main list. A main list's copies lose every
 * entry it does not have, so it must hold every kind of entry: a list that holds
 * only watch history (Trakt) has no planned, paused, or unwatched entries, and
 * with it as main every such entry on the others would be removed. Pure.
 */
export function canBeMain(tracker: Tracker): boolean {
  return trackerFamily(tracker) !== "seasoned";
}

/** What an entry holds now, for the preview's "was ...". Pure. */
export function stateOf(e: ListEntry): EntryState {
  if (e.shape === "cour") {
    return { status: e.status, progress: e.progress, total: e.total, rating: e.rating };
  }
  if (e.shape === "movie")
    return { status: e.status ?? null, watched: e.watched, rating: e.rating };
  const episodes = Object.values(e.seasons).reduce((n, eps) => n + eps.length, 0);
  return { status: e.status ?? null, episodes, rating: e.rating };
}

/** Whether a tracker keeps a rewatch count (AniList `repeat`, MAL
 * `num_times_rewatched`). Simkl reads as 0 and has nothing to write it to. Pure. */
export const keepsRepeat = (tk: Tracker) => trackerFamily(tk) === "cour";

/** Whether a tracker keeps start and finish days on an entry (AniList, MAL). Simkl
 * has none to write them to. Pure. */
export const keepsDays = (tk: Tracker) => trackerFamily(tk) === "cour";

/** COMPLETED and REPEATING both mean "finished at least once". */
export const finished = (s: CourStatus | null | undefined) =>
  s === "COMPLETED" || s === "REPEATING";

/** Status as compared across trackers: a rewatch is a completed entry. Pure. */
export const normStatus = (s: CourStatus): CourStatus => (s === "REPEATING" ? "COMPLETED" : s);

/** Episodes a cour entry counts as watched. A finished entry counts in full, even
 * mid-rewatch (AniList REPEATING at 3 of 12 still means 12 were watched). */
export function courCount(e: CourEntry): number {
  if (e.movie) return e.progress > 0 || finished(e.status) ? 1 : 0;
  return finished(e.status) ? Math.max(e.progress, e.total ?? e.progress) : e.progress;
}

/** The keys Trakt and Simkl share for a show or movie (tmdb, imdb, tvdb). Pure. */
export function sharedKeys(ids: SyncIds, movie: boolean): string[] {
  return baseKeys({ tmdb: ids.tmdb, imdb: ids.imdb, tvdb: ids.tvdb }, movie ? "movie" : "tv");
}

export function mergeIds(entries: { ids: SyncIds }[]): SyncIds {
  const ids: SyncIds = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.ids) as [keyof SyncIds, never][]) {
      if (v !== undefined && ids[k] === undefined) ids[k] = v;
    }
  }
  return ids;
}

export function hasEpisode(e: SeasonedEntry, season: number, episode: number): boolean {
  return e.shape === "seasons" && (e.seasons[season] ?? []).includes(episode);
}

export function sortEps(eps: EpisodeRef[]): EpisodeRef[] {
  return eps.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || a.number - b.number);
}
