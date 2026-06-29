import type { ParsedMedia } from "@tmsync/shared";
import type {
  RatingLevel,
  RecordPhase,
  RecordResult,
  TrackedItem,
  Tracker,
  WatchedState,
} from "./types";

/**
 * One seam, two implementations (Trakt, AniList). Adding AniList must not touch
 * the Trakt path — both satisfy this interface and the background routes to one
 * by `recipe.tracker`. The two progress paradigms are genuinely different (Trakt
 * = real-time scrobble owning the watched decision; AniList = one threshold write
 * we decide) so `recordProgress` is phase-based and each adapter interprets the
 * phases as its API needs (see CLAUDE.md "Tracker adapters").
 */
export interface TrackerAdapter {
  readonly tracker: Tracker;

  /** Is the user connected to this tracker? */
  isConnected(): Promise<boolean>;

  /** Resolve scraped media → a tracker item (cached), or null if nothing matches. */
  resolve(media: ParsedMedia): Promise<TrackedItem | null>;

  /**
   * Record a progress phase for a resolved item.
   *  - Trakt: real-time scrobble start/pause/stop; Trakt owns the ≥80% decision.
   *  - AniList: no scrobble API — start/pause are no-ops; a `stop` at/after
   *    `watchedThreshold` writes `SaveMediaListEntry` once (idempotent).
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
   * Which levels this tracker lets the user rate for the given media — empty if
   * rating is unsupported. The shared badge renders only these affordances.
   */
  ratingLevels(media: ParsedMedia): RatingLevel[];

  /**
   * The viewer's watched progress for a resolved show (the popup's "last watched /
   * next up" line). Returns null when unsupported (movies), not connected, or no
   * data — a read, so it never writes. Requires auth.
   */
  watchedState(item: TrackedItem): Promise<WatchedState | null>;
}
