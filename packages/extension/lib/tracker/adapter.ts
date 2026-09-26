import type { IdNamespace, ParsedMedia } from "@tmsync/shared";
import type { ScoreFormat } from "../anilist/types";
import type {
  ExternalIds,
  RatingLevel,
  RecordPhase,
  RecordResult,
  TrackedItem,
  Tracker,
  WatchedState,
} from "./types";

/**
 * One seam, one implementation per tracker (Trakt, AniList, MAL, Simkl). Adding a
 * tracker must not touch the others' paths: all satisfy this interface and the
 * background routes to them by the recipe's tracker list. The two progress
 * paradigms are genuinely different (scrobble: Trakt and Simkl send start/pause/stop
 * and the tracker owns the watched decision; cour list: AniList and MAL write once
 * at a threshold we decide), so `recordProgress` is phase-based and each adapter
 * interprets the phases as its API needs (see CLAUDE.md "Tracker adapters").
 */
export interface TrackerAdapter {
  readonly tracker: Tracker;

  /**
   * Id namespaces this adapter resolves DIRECTLY (native), strongest first — e.g.
   * Trakt `["tmdb","imdb","tvdb"]`, AniList `["anilist","mal"]`. A page id in one
   * of these is looked up exactly; anything else is reached via the crosswalk
   * (derived) or a title search. Drives native-vs-derived inference so adding a
   * tracker never special-cases the shared engine (docs/IDENTITY-NAMESPACES.md).
   */
  readonly resolvableNamespaces: readonly IdNamespace[];

  /** Is the user connected to this tracker? */
  isConnected(): Promise<boolean>;

  /** Resolve scraped media → a tracker item (cached), or null if nothing matches. */
  resolve(media: ParsedMedia): Promise<TrackedItem | null>;

  /**
   * Resolve an EXACT entry that derivation already named (crosswalk, user pin, or a
   * same-family sibling), by id. No title fallback: a title search could pick
   * another cour. The adapter uses whichever id it can (e.g. MAL from `mal`, or
   * from `anilist` via AniList's `idMal`); null when none fits. `media` is the
   * derived media: the adapter may look up a user pin keyed by it (a title
   * correction), which wins over the ids. Optional: a tracker without it is
   * resolved from the derived media.
   */
  resolveById?(ids: ExternalIds, media: ParsedMedia): Promise<TrackedItem | null>;

  /**
   * Record a progress phase for a resolved item.
   *  - Trakt, Simkl: real-time scrobble start/pause/stop; the tracker owns the
   *    80% decision (Simkl allows one call per 20 s, so it may drop a start/pause).
   *  - AniList, MAL: no scrobble API. Start/pause only read the entry; a `stop`
   *    at/after `watchedThreshold` writes the list entry once (idempotent).
   */
  recordProgress(
    item: TrackedItem,
    media: ParsedMedia,
    /** 0–100. */
    progress: number,
    phase: RecordPhase,
    /** 0–1; per-recipe "treat as finished here" point. */
    watchedThreshold: number,
  ): Promise<RecordResult>;

  /**
   * How long a `stop` would wait before this tracker can take it (ms, 0 = now).
   * Simkl allows one scrobble call per 20 s, so a stop inside that window waits.
   * The background then records the tracker after replying, so the badge shows the
   * other trackers at once. Optional: a tracker without it never waits.
   */
  stopDelayMs?(): Promise<number>;

  /**
   * The user confirmed a rewatch of a completed entry (after `needs_rewatch`):
   * write the rewatch transition. `watched` says this episode already played past
   * the threshold, so it counts now; else it counts at its own stop. Only trackers
   * that ask first (the cour family) implement it.
   */
  confirmRewatch?(item: TrackedItem, media: ParsedMedia, watched: boolean): Promise<RecordResult>;

  /**
   * Which levels this tracker lets the user rate for the given media — empty if
   * rating is unsupported. The shared badge renders only these affordances.
   */
  ratingLevels(media: ParsedMedia): RatingLevel[];

  /**
   * The score scale the user picked on this tracker, when it is theirs to pick
   * (AniList's `scoreFormat`). Optional: a tracker without it rates 1 to 10.
   */
  scoreFormat?(): Promise<ScoreFormat | null>;

  /**
   * The viewer's watched progress for a resolved show (the popup's "last watched /
   * next up" line). Returns null when unsupported (movies), not connected, or no
   * data — a read, so it never writes. Requires auth.
   */
  watchedState(item: TrackedItem): Promise<WatchedState | null>;
}
