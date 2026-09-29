/** MyAnimeList API types: only the fields TMSync uses. */
import type { CourStatus } from "../cour-plan";

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
export const MAL_STATUSES = [
  "watching",
  "completed",
  "on_hold",
  "dropped",
  "plan_to_watch",
] as const;
export type MalListStatusValue = (typeof MAL_STATUSES)[number];

/** A MAL status in cour terms. MAL has no rewatching status: a completed entry with
 * `is_rewatching` set is REPEATING (`toCourEntry`). */
export const MAL_TO_COUR: Record<MalListStatusValue, Exclude<CourStatus, "REPEATING">> = {
  watching: "CURRENT",
  completed: "COMPLETED",
  on_hold: "PAUSED",
  dropped: "DROPPED",
  plan_to_watch: "PLANNING",
};

/** A cour status in MAL's words: `MAL_TO_COUR` the other way. */
export const COUR_TO_MAL = Object.fromEntries(
  Object.entries(MAL_TO_COUR).map(([mal, cour]) => [cour, mal]),
) as Record<Exclude<CourStatus, "REPEATING">, MalListStatusValue>;

/** `my_list_status` as MAL returns it (fields we read). */
export interface MalListStatus {
  status?: MalListStatusValue;
  num_episodes_watched?: number;
  is_rewatching?: boolean;
  num_times_rewatched?: number;
  score?: number;
  comments?: string;
  /** `2024-03-09`, or only `2024-03` or `2024`. */
  start_date?: string;
  finish_date?: string;
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
