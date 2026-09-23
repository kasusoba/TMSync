import type { IdNamespace, ParsedMedia } from "@tmsync/shared";
import type {
  RatingLevel,
  RecordPhase,
  RecordResult,
  TrackedItem,
  Tracker,
  WatchedState,
} from "./types";

/**
 * One seam, one implementation per tracker (Trakt, AniList). Adding a tracker must
 * not touch the others' paths: all satisfy this interface and the background routes
 * to them by the recipe's tracker list. The two progress paradigms are genuinely different (Trakt
 * = real-time scrobble owning the watched decision; AniList = one threshold write
 * we decide) so `recordProgress` is phase-based and each adapter interprets the
 * phases as its API needs (see CLAUDE.md "Tracker adapters").
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
   * Resolve an EXACT entry the crosswalk (or a user pin) already named, by id only.
   * No correction lookup and no title fallback: a title search could pick another
   * cour. Called only when `ids` holds one of `resolvableNamespaces`. Optional: a
   * tracker without it is resolved from the derived media instead.
   */
  resolveById?(ids: Partial<Record<IdNamespace, number>>): Promise<TrackedItem | null>;

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
