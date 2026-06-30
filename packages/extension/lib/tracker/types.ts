/**
 * The tracker-adapter seam (CLAUDE.md → "Tracker adapters"). One interface, two
 * implementations (Trakt, AniList), picked per recipe by `recipe.tracker`. The
 * shared engine (extract/video/session/badge) stays tracker-agnostic; everything
 * tracker-specific lives behind `TrackerAdapter`.
 */

/** The two (and only two) trackers. Routed, never synced (constraint #1). */
export type Tracker = "trakt" | "anilist";

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
      /** Trakt URL slug + TMDB id, free from the search result. TMDB id powers the
       * Discord RP poster lookup; slug is kept for building Trakt links. */
      slug?: string;
      tmdbId?: number;
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
      /** Cover image URL (the Discord RP poster); from `Media.coverImage`. */
      coverUrl?: string;
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
