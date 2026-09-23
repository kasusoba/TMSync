/**
 * The tracker-adapter seam (CLAUDE.md → "Tracker adapters"). One interface, N
 * implementations (Trakt, AniList, MAL so far), picked per recipe by its tracker list.
 * The shared engine (extract/video/session/badge) stays tracker-agnostic; everything
 * tracker-specific lives behind `TrackerAdapter` + the metadata below.
 */

import type { IdNamespace } from "@tmsync/shared";

/** The trackers — a growing list (multi-track, constraint #1). Add a member here,
 * then a `TRACKER_INFO` entry, an adapter (registered in `getAdapter`), a mark, and
 * a picker toggle. Nothing should switch on the string with an "else ⇒ trakt" default. */
export type Tracker = "trakt" | "anilist" | "mal";

/**
 * How a tracker numbers episodes. Trackers in one family share numbering, so moving
 * an item between them only changes the id. Moving it between families needs the
 * anime-map crosswalk (`lib/animap/`), which maps one family to the other.
 *  - `seasoned`: season + episode, keyed by TMDB/IMDB/TVDB ids (Trakt).
 *  - `cour`: one entry per cour, linear episodes, no seasons (AniList, MAL).
 */
export type NumberingFamily = "seasoned" | "cour";

/**
 * Static per-tracker metadata, the SINGLE source for a tracker's display name and
 * numbering family. Pure data (no adapter/client code), so it imports weightlessly
 * into the injected UI. Read it through the helpers below instead of comparing
 * tracker names.
 */
export interface TrackerInfo {
  /** Display name (badge, panels, account rows). */
  label: string;
  /** How the tracker numbers episodes. The badge drops the season for a `cour`
   * tracker; derivation uses the crosswalk only across families. */
  family: NumberingFamily;
  /** The id namespace of the tracker's OWN ids, when that namespace is one the
   * crosswalk knows (AniList ids are `anilist`). Trakt ids are not a namespace. */
  ownNamespace?: IdNamespace;
}

export const TRACKER_INFO: Record<Tracker, TrackerInfo> = {
  trakt: { label: "Trakt", family: "seasoned" },
  anilist: { label: "AniList", family: "cour", ownNamespace: "anilist" },
  mal: { label: "MyAnimeList", family: "cour", ownNamespace: "mal" },
};

/** Trackers whose pages can host quick links (each has a quick-link content
 * script). A subset of `Tracker`: a new tracker gets links only with its own script. */
export type QuickLinkTracker = "trakt" | "anilist";

/** The quick-link trackers, in display order (the quick-link editors' tabs). */
export const QUICK_LINK_TRACKERS: QuickLinkTracker[] = ["trakt", "anilist"];

/** All trackers in a stable order — for UI iteration (toggles, tabs) + registries. */
export const ALL_TRACKERS = Object.keys(TRACKER_INFO) as Tracker[];

/** A tracker's display name. Use everywhere instead of `t === "anilist" ? … : "Trakt"`. */
export const trackerLabel = (tracker: Tracker): string => TRACKER_INFO[tracker].label;

/** A tracker's numbering family. */
export const trackerFamily = (tracker: Tracker): NumberingFamily => TRACKER_INFO[tracker].family;

/** Whether a tracker's numbering is seasonless (the `cour` family). */
export const isSeasonless = (tracker: Tracker): boolean => trackerFamily(tracker) === "cour";

/** Ids of one entry in other trackers' namespaces. Inside a numbering family these
 * bridge trackers without the crosswalk (an AniList entry's `mal` id is its MAL
 * entry: the two are 1:1). */
export type ExternalIds = Partial<Record<IdNamespace, number>>;

/**
 * A resolved item on a specific tracker — the seam-level identity. A discriminated
 * union: the Trakt arm carries the trakt id; the AniList arm carries the Media id
 * plus the entry's total `episodes` (the numbering-guardrail input, step 6).
 */
export type TrackedItem =
  | {
      tracker: "trakt";
      mediaType: "movie" | "show";
      /** Trakt id. */
      id: number;
      title: string;
      year?: number;
    }
  | {
      tracker: "anilist";
      /** AniList series entries are always shows here (anime movies route to Trakt). */
      mediaType: "show";
      /** AniList `Media` id. */
      id: number;
      title: string;
      year?: number;
      /** Total episodes on the AniList entry; null when unknown/ongoing. */
      episodes: number | null;
      /** Other ids the same entry is known by (AniList `idMal` ⇒ `mal`). */
      ids?: ExternalIds;
    }
  | {
      tracker: "mal";
      /** Cour entries; anime movies route to Trakt, like AniList. */
      mediaType: "show";
      /** MAL anime id. */
      id: number;
      title: string;
      year?: number;
      /** Total episodes on the MAL entry; null when unknown/ongoing. */
      episodes: number | null;
      /** Other ids the same entry is known by. */
      ids?: ExternalIds;
    };

/** A progress phase from the content-side scrobble state machine. */
export type RecordPhase = "start" | "pause" | "stop";

/**
 * Normalized outcome of `recordProgress`, mapped to a `ScrobbleReply` by the
 * background. Adapters never throw for connection/HTTP issues — they fold them
 * into `reason` so the background stays tracker-agnostic.
 */
export interface RecordResult {
  ok: boolean;
  /** Underlying HTTP status, when a call was made. */
  status?: number;
  /** Echoed/normalized action; "scrobble" = committed (Trakt history / AniList write). */
  action?: "start" | "pause" | "scrobble";
  /**
   * Why it failed, or why nothing was written. `needs_rewatch` = a COMPLETED
   * AniList cour was re-watched; we wrote nothing and the badge must ask the user
   * to confirm a rewatch first (never silently mutate a completed entry).
   */
  reason?:
    | "unresolved"
    | "no_episode"
    | "numbering_mismatch"
    | "needs_rewatch"
    | "not_connected"
    | "http";
  /** AniList only: this write finished the cour (drives the cour-rating prompt). */
  completed?: boolean;
  /** Tracker error body / detail for the badge. */
  httpError?: string;
  /** Benign informational outcome (ok, but nothing written). `already_watched` =
   * the scraped episode is at/below the tracker's recorded progress, so it won't
   * advance — surfaced to the badge instead of a confusing "stopped". */
  info?: "already_watched";
  /** With `info: "already_watched"`: the tracker's current progress (episode #). */
  atEpisode?: number;
}

/**
 * Which rating affordances a tracker offers for an item — drives the badge so it
 * renders only supported levels (Trakt: show/season/episode; AniList: the cour
 * entry). "cour" is the single AniList anime-entry level (no per-episode score).
 */
export type RatingLevel = "movie" | "show" | "season" | "episode" | "cour";

/** A single episode reference. `season` is omitted for AniList (linear cour). */
export interface WatchedEpisode {
  season?: number;
  number: number;
}

/**
 * The viewer's watched progress for a resolved show — drives the popup
 * "last watched / next up" line. Normalized across the two trackers' very
 * different storage models: Trakt keeps a true per-episode SET (gaps possible —
 * watched 1,3 not 2), AniList keeps only a high-water-mark COUNT (no gaps). Both
 * reduce to this shape; `hasGaps` flags the Trakt-only case where `next` points
 * *behind* `lastWatched`.
 */
export interface WatchedState {
  tracker: Tracker;
  /** Episodes that exist to watch (aired count for Trakt; cour total for AniList); null if unknown/ongoing. */
  total: number | null;
  /** How many episodes are watched. */
  watchedCount: number;
  /** Most recent watch (by time on Trakt; = progress on AniList); null if none. */
  lastWatched: WatchedEpisode | null;
  /** First unwatched episode in order; null when fully caught up / completed. */
  next: WatchedEpisode | null;
  /** Trakt only: `next` sits before `lastWatched` (an earlier episode is unwatched). Always false for AniList. */
  hasGaps: boolean;
}
