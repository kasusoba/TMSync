/** AniList API types — only the fields TMSync uses. */

/**
 * Authorization-code token set (AniList dropped implicit grant). The access token
 * has a ~1-year lifetime. `obtained_at` is our local issue timestamp (Unix
 * seconds) for expiry math; `refresh_token` is stored if AniList returns one
 * (not currently used — on expiry we just prompt a reconnect).
 */
export interface AniListTokens {
  access_token: string;
  token_type: "Bearer";
  /** Lifetime in seconds (~1 year). */
  expires_in: number;
  refresh_token?: string;
  /** Unix seconds when we stored it (we add this; AniList doesn't send it). */
  obtained_at: number;
}

/**
 * AniList's per-user score scale (`Viewer.mediaListOptions.scoreFormat`). We read
 * it to render the score affordance; writes use `scoreRaw` (0–100) so they're
 * format-agnostic.
 */
export type ScoreFormat = "POINT_100" | "POINT_10_DECIMAL" | "POINT_10" | "POINT_5" | "POINT_3";

/**
 * AniList list-entry status. We READ all of them (to decide transitions) but only
 * ever WRITE `CURRENT` / `COMPLETED` / `REPEATING` (never PLANNING/PAUSED/DROPPED —
 * we don't set those ourselves).
 */
export type MediaListStatus =
  | "CURRENT"
  | "PLANNING"
  | "COMPLETED"
  | "DROPPED"
  | "PAUSED"
  | "REPEATING";

/** The viewer's existing list entry for a Media (null when not on their list). */
export interface AniListEntry {
  status: MediaListStatus | null;
  progress: number;
  repeat: number;
}

/**
 * A resolved AniList identity, cached per scraped (title,year). `episodes` is the
 * entry's total (null = unknown/ongoing) — the numbering-guardrail input (step 6).
 */
export interface AniListIdentity {
  /** AniList `Media` id. */
  id: number;
  title: string;
  year?: number;
  episodes: number | null;
  /** MAL id, if any — bridges to MAL-keyed data later; not used in v1. */
  idMal?: number;
  /** Cover image URL (the Discord RP poster); from `Media.coverImage`. */
  coverUrl?: string;
}
