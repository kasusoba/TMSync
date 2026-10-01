import type { CourStatus } from "../trackers/cour-plan";
import type { Tracker } from "../trackers/types";
/**
 * List sync types (docs/ARCHITECTURE.md section 7). Each tracker reads its whole list into
 * `ListEntry` values, the pure planner (`plan/`) groups them and decides what
 * each tracker is missing, and the result is a `SyncPlan`. Nothing here talks to a
 * tracker: the readers live with each tracker (`lib/trackers/<tracker>/list.ts`).
 */
import type { Day } from "./read-util";

/** What an item is. A tracker can be kept out of a kind (Simkl without anime). */
export type SyncKind = "movie" | "tv" | "anime";

export const SYNC_KINDS: readonly SyncKind[] = ["movie", "tv", "anime"];

/** The ids an entry is known by. `imdb` is a string (`tt…`), the rest are numbers. */
export interface SyncIds {
  tmdb?: number;
  imdb?: string;
  tvdb?: number;
  anilist?: number;
  mal?: number;
}

/** Watched episodes by season number. */
export type SeasonEpisodes = Record<number, number[]>;

interface EntryBase {
  tracker: Tracker;
  /** The tracker's own id for the entry. */
  id: number;
  title: string;
  year?: number;
  ids: SyncIds;
  /** The user's score, 0 to 100 (null = not rated). */
  rating: number | null;
  /** When the entry last changed (ms), for "most recent wins". A rating or a
   * watchlist add moves it too, so it is not a watch date. */
  updatedAt?: number;
  /** When the user last watched some of it (ms), as near as the tracker says: the
   * date a backfilled watch gets. Trakt and Simkl give the last watch. AniList and
   * MAL give the finish day of a finished entry, else only the last change, which
   * can be later than the watch but never earlier. Missing = unknown. */
  watchedAt?: number;
  /** The user hid the entry (AniList `private` or hidden from status lists). */
  private?: boolean;
  /** Adult content (AniList `isAdult`, MAL `nsfw: black`). */
  adult?: boolean;
}

/**
 * One entry of a tracker's list, in one of three shapes:
 *  - `movie`: watched or not (Trakt, Simkl movies).
 *  - `seasons`: a set of watched episodes by season (Trakt shows, Simkl shows).
 *  - `cour`: a count of watched episodes plus a status (AniList, MAL, Simkl anime).
 */
export type ListEntry =
  | (EntryBase & {
      shape: "movie";
      watched: boolean;
      /** Simkl keeps a status (plan to watch, dropped) on movies too. */
      status?: CourStatus | null;
      /** The tracker files it as anime (a Simkl `anime` entry). */
      anime?: boolean;
    })
  | (EntryBase & {
      shape: "seasons";
      seasons: SeasonEpisodes;
      /** Season ratings, 0 to 100, by season number (Trakt only). */
      seasonRatings?: Record<number, number>;
      status?: CourStatus | null;
      anime?: boolean;
    })
  | (EntryBase & {
      shape: "cour";
      /** Episodes watched (a count, no gaps). */
      progress: number;
      /** Episodes in the entry, null when unknown or airing. */
      total: number | null;
      status: CourStatus | null;
      /** Completed rewatches. */
      repeat: number;
      /** An anime movie (one episode). */
      movie?: boolean;
      /** The start and finish days the user keeps on the entry (AniList, MAL). */
      startedOn?: Day;
      finishedOn?: Day;
    });

/** What the user chose for list sync. Stored in `sync` storage. */
export interface ListSyncSettings {
  /** The kinds each tracker takes part in. A missing tracker takes every kind it
   * can (see `syncKindsFor`). An empty list keeps the tracker out of sync. */
  kinds: Partial<Record<Tracker, SyncKind[]>>;
  /** Copy entries the user hid on AniList to the other trackers. */
  includePrivate: boolean;
  /** Copy adult entries. */
  includeAdult: boolean;
  /** Group keys the user keeps out of sync (`SyncItem.key`). */
  ignore: string[];
  /**
   * The main list per kind. With one, that kind stops being a union: the main
   * list is the truth, the others copy it, and an entry the main list does not
   * have is removed from the others (a list entry only, never Trakt watch
   * history). The copies' progress still never goes down. Missing = union.
   */
  main?: Partial<Record<SyncKind, Tracker>>;
  /** Sync once a day on its own, additions only (`auto.ts`). Off by default. Per
   * device: it is kept in `local`, not synced (see `listSyncSettings`). */
  auto?: boolean;
}

export const DEFAULT_SYNC_SETTINGS: ListSyncSettings = {
  kinds: {},
  includePrivate: false,
  includeAdult: false,
  ignore: [],
};

/** One episode to add to a tracker that keeps watched episodes. */
export interface EpisodeRef {
  season?: number;
  number: number;
}

/** A change of one value, for the preview. */
export interface Change<T> {
  from: T;
  to: T;
}

/**
 * How a write names its item on the target tracker. `id` is the tracker's own id
 * when it has the entry. Otherwise the ids let the tracker match it (Trakt and
 * Simkl match from tmdb, imdb, tvdb, mal, or anilist; AniList and MAL need their
 * own id, which is in `ids`).
 */
export interface TargetRef {
  id?: number;
  ids: SyncIds;
  mediaType: "movie" | "show";
  /** Where Simkl files it: the `anime` section takes episodes without seasons. */
  anime?: boolean;
}

/** What a target entry held before the write, for the preview ("was ..."). */
export interface EntryState {
  status?: CourStatus | null;
  /** Episodes watched on a count tracker, of `total`. */
  progress?: number;
  total?: number | null;
  /** A movie on a watched-set tracker. */
  watched?: boolean;
  /** Episodes watched on a watched-set tracker. */
  episodes?: number;
  /** 0 to 100, null = not rated. */
  rating?: number | null;
}

export type SyncWrite =
  /** Mark episodes watched (Trakt, Simkl). */
  | {
      tracker: Tracker;
      op: "episodes";
      target: TargetRef;
      add: EpisodeRef[];
      /** Missing = the tracker does not have the item yet. */
      was?: EntryState;
      /** When the source last changed (ms), the date the watches get. Missing =
       * unknown, and the tracker uses the air date. */
      at?: number;
    }
  /** Mark a movie watched (Trakt, Simkl). */
  | { tracker: Tracker; op: "movie"; target: TargetRef; was?: EntryState; at?: number }
  /** Create or update a list entry (AniList, MAL, Simkl anime). */
  | {
      tracker: Tracker;
      op: "entry";
      target: TargetRef;
      /** True when the tracker has no entry yet. */
      create: boolean;
      progress?: Change<number>;
      status?: Change<CourStatus | null>;
      repeat?: Change<number>;
      /** The date new watches get, where the tracker keeps one (Simkl). */
      at?: number;
      /** A start or finish day for an entry that has none (AniList, MAL). Sync
       * only fills an empty day, never changes one. */
      startedOn?: Day;
      finishedOn?: Day;
    }
  /** Set the status of a movie or a whole show on a tracker that keeps watches
   * by episode (`plan/status.ts`): Trakt's watchlist or dropped list, a WeTrakr
   * tracking list, a Simkl list. `to` can be a status the tracker cannot hold:
   * then the write only leaves `from` (Trakt leaves the watchlist). */
  | {
      tracker: Tracker;
      op: "status";
      target: TargetRef;
      status: Change<CourStatus | null>;
      was?: EntryState;
    }
  /** Remove the entry from the tracker's list: a main list does not have it, or
   * another list removed it since the last sync (`base.ts`). Only list
   * entries: Trakt watch history is never removed. */
  | { tracker: Tracker; op: "remove"; target: TargetRef; was: EntryState }
  /** Clear a rating: the user removed it from another list since the last
   * sync (`base.ts`). `was` is the rating now, 0 to 100. */
  | ({ tracker: Tracker; op: "unrate"; was: number } & RatingRef)
  /** Fill an empty rating. `score` is 0 to 100. */
  | ({ tracker: Tracker; op: "rating"; score: number } & RatingRef & {
        /** The user picked this score in a disagreement, so it replaces the
         * tracker's own rating (else sync only fills an empty one). */
        picked?: boolean;
      });

/** Where one tracker keeps the rating of an item. */
export interface RatingRef {
  target: TargetRef;
  level: "movie" | "show" | "season" | "entry";
  season?: number;
}

/** One item that changes, with every write it needs. */
export interface SyncItem {
  /** Stable group key (the ignore list uses it): `anilist:123`, `mal:5`,
   * `tv:tmdb:1399`, `movie:imdb:tt0111161`, and so on. */
  key: string;
  kind: SyncKind;
  title: string;
  year?: number;
  writes: SyncWrite[];
}

export type SkipReason =
  /** The user keeps this item out of sync. */
  | "ignored"
  /** Hidden on AniList (private), and private entries are not copied. */
  | "private"
  /** Adult content, and adult entries are not copied. */
  | "adult"
  /** The crosswalk cannot pick one entry (a split it cannot tell apart). */
  | "ambiguous"
  /** Not in the crosswalk, so it cannot cross between numbering families. */
  | "not_mapped"
  /** The progress is above the target's episode count (numbering does not match). */
  | "numbering"
  /** No id the target tracker can use. */
  | "no_id"
  /** The tracker answered "not found" for it (or for these episodes) on an
   * earlier apply, so it is not sent again for a while (`misses.ts`). */
  | "not_on_tracker"
  /** This kind has a main list, but it was not read (not connected, or failed),
   * so nothing of this kind is planned. */
  | "main_missing";

/** Something sync will not do, and why. `tracker` is the one that misses out. */
export interface SyncSkip {
  key: string;
  title: string;
  tracker?: Tracker;
  reason: SkipReason;
  detail?: string;
}

/** Two trackers disagree and sync cannot tell which is right. */
export interface SyncConflict {
  key: string;
  title: string;
  kind: SyncKind;
  field: "status" | "rating";
  /** Each tracker's value (a status, or a score 0 to 100), newest first. */
  values: { tracker: Tracker; value: string | number; at?: number }[];
  /** What sync will use, when it picks one (status: the most recent). Null = it
   * writes nothing for this field until the user picks. */
  chosen: { tracker: Tracker; value: string | number } | null;
  /** Rating only: where each tracker taking part keeps this rating, so a score
   * the user picks can be written to all of them. */
  refs?: ({ tracker: Tracker } & RatingRef)[];
  /** Status only: each tracker that holds this entry's status, so a status the
   * user picks can be written to all of them. */
  targets?: StatusTarget[];
  /** What the user picked (see `withPicks`): a score (0 to 100), or a status. */
  picked?: SyncPick;
}

/** One tracker's entry in a status disagreement: where it is, the status it has
 * now, and the progress and length it will have after sync (a picked status must
 * still follow them: a finished entry is completed, one with progress is not
 * "plan to watch"). A completed entry is never listed: sync never moves it. */
export interface StatusTarget {
  tracker: Tracker;
  target: TargetRef;
  /** The tracker has the entry now. */
  exists: boolean;
  status: CourStatus | null;
  progress: number;
  total: number | null;
  /** A tracker that keeps watches by episode: the pick is a `status` write on
   * this movie or show (`plan/status.ts`), not a list entry. */
  shape?: "movie" | "show";
}

/** A choice in a disagreement: a score (0 to 100) for a rating, a status for a
 * status. */
export type SyncPick = number | CourStatus;

/** The user's picks, by `pickKey`. */
export type SyncPicks = Record<string, SyncPick>;

/** The key of a disagreement's pick. One item can disagree on both fields. Pure. */
export function pickKey(c: { key: string; field: SyncConflict["field"] }): string {
  return `${c.field}:${c.key}`;
}

/**
 * A copy of a main list that sync leaves as it is, and why. Sync tells the user
 * instead of acting, because acting would lower progress or delete history.
 */
export interface SyncNotice {
  key: string;
  title: string;
  kind: SyncKind;
  /** The copy that differs from the main list. */
  tracker: Tracker;
  reason: /** The copy is further than the main list. Sync never lowers progress. */
    | "ahead"
    /** The main list does not have it (or another list removed it), but this
     * copy is Trakt watch history, which sync never removes. */
    | "history_kept"
    /** The copy has a different rating. Sync only fills empty ratings. */
    | "rating_kept";
  detail?: string;
}

export interface SyncPlan {
  items: SyncItem[];
  skips: SyncSkip[];
  conflicts: SyncConflict[];
  /** Copies left as they are (see `SyncNotice`). */
  notices: SyncNotice[];
  /** Removed marks for the next base (`base.ts`): the lists that removed an item
   * a kept copy (watch history) still has, with the item's id keys on that list. */
  removed?: { tracker: Tracker; keys: string[] }[];
}

/** Per-tracker totals, for the preview header. */
export interface SyncTotals {
  tracker: Tracker;
  episodes: number;
  movies: number;
  created: number;
  updated: number;
  ratings: number;
  removed: number;
  /** Ratings cleared. */
  unrated: number;
}

/** What became of one write when sync applied it. */
export interface WriteOutcome {
  ok: boolean;
  /**
   * `not_found`: the tracker could not match the item. `changed`: the entry
   * changed since the preview, so the write no longer applied and was left out
   * (never a failure: the next preview plans from what is there now).
   */
  reason?: "not_found" | "changed" | "failed";
  error?: string;
}

/** The outcome of one chunk of a tracker's writes, one result per write in order.
 * `stop` = do not call this tracker again in this run, and why (it is limiting
 * requests, or it was disconnected). The writes after the stop were not sent. */
export interface ChunkOutcome {
  results: WriteOutcome[];
  stop?: string;
}
