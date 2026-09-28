/**
 * List sync types (plans/list-sync.md). Each tracker reads its whole list into
 * `ListEntry` values, the pure planner (`plan.ts`) groups them and decides what
 * each tracker is missing, and the result is a `SyncPlan`. Nothing here talks to a
 * tracker: the readers live with each tracker (`lib/trackers/<tracker>/list.ts`).
 */
import type { CourStatus } from "../trackers/cour-plan";
import type { Tracker } from "../trackers/types";

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
  /** When the entry last changed (ms), for "most recent wins". */
  updatedAt?: number;
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

export type SyncWrite =
  /** Mark episodes watched (Trakt, Simkl). */
  | { tracker: Tracker; op: "episodes"; target: TargetRef; add: EpisodeRef[] }
  /** Mark a movie watched (Trakt, Simkl). */
  | { tracker: Tracker; op: "movie"; target: TargetRef }
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
    }
  /** Fill an empty rating. `score` is 0 to 100. */
  | {
      tracker: Tracker;
      op: "rating";
      target: TargetRef;
      level: "movie" | "show" | "season" | "entry";
      season?: number;
      score: number;
    };

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
  | "no_id";

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
  field: "status" | "rating";
  /** Each tracker's value (a status, or a score 0 to 100), newest first. */
  values: { tracker: Tracker; value: string | number; at?: number }[];
  /** What sync will use, when it picks one (status: the most recent). Null = it
   * writes nothing for this field until the user picks. */
  chosen: { tracker: Tracker; value: string | number } | null;
}

export interface SyncPlan {
  items: SyncItem[];
  skips: SyncSkip[];
  conflicts: SyncConflict[];
}

/** Per-tracker totals, for the preview header. */
export interface SyncTotals {
  tracker: Tracker;
  episodes: number;
  movies: number;
  created: number;
  updated: number;
  ratings: number;
}
