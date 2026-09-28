/** MyAnimeList API types: only the fields TMSync uses. */

/** OAuth token set. MAL rotates the refresh token on every refresh. */
export interface MalTokens {
  access_token: string;
  refresh_token: string;
  /** Access-token lifetime in seconds, as MAL reports it (docs disagree, so trust this). */
  expires_in: number;
  /** Unix seconds when we stored it (we add this; MAL doesn't send it). */
  obtained_at: number;
}

/** MAL's own list status values. */
export type MalListStatusValue = "watching" | "completed" | "on_hold" | "dropped" | "plan_to_watch";

/** `my_list_status` as MAL returns it (fields we read). */
export interface MalListStatus {
  status?: MalListStatusValue;
  num_episodes_watched?: number;
  is_rewatching?: boolean;
  num_times_rewatched?: number;
  score?: number;
  comments?: string;
}

/** An anime node from search or details (fields we request). */
export interface MalAnimeNode {
  id: number;
  title: string;
  alternative_titles?: { synonyms?: string[]; en?: string; ja?: string } | null;
  start_date?: string | null;
  media_type?: string | null;
  num_episodes?: number | null;
  my_list_status?: MalListStatus | null;
}

/**
 * A resolved MAL identity, cached per scraped media. `episodes` is the entry's
 * total (null = unknown or ongoing, MAL reports 0), the numbering-guardrail input.
 */
export interface MalIdentity {
  /** MAL anime id. */
  id: number;
  title: string;
  year?: number;
  episodes: number | null;
}
