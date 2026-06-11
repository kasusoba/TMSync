import type { ParsedMedia } from "@tmsync/shared";
import type {
  RatingSyncBody,
  ResolvedIdentity,
  ReviewLevel,
  ScrobbleBody,
  TraktTokens,
} from "./types";

/**
 * Trakt `progress` is a 0–100 float. Coerce non-finite to 0, clamp, and round to
 * 2 decimals — high-precision floats are a known cause of 422 on /scrobble/*.
 */
export function clampProgress(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(100, Math.max(0, n));
  return Math.round(clamped * 100) / 100;
}

/**
 * Build a /scrobble body from a resolved identity + the scraped media. Returns
 * null for a show that's missing season/episode (we can't scrobble an episode
 * without both). Pure — unit tested.
 */
export function buildScrobbleBody(
  identity: ResolvedIdentity,
  media: ParsedMedia,
  progress: number,
): ScrobbleBody | null {
  const p = clampProgress(progress);
  if (identity.mediaType === "movie") {
    return { movie: { ids: { trakt: identity.traktId } }, progress: p };
  }
  if (media.season === undefined || media.episode === undefined) return null;
  return {
    show: { ids: { trakt: identity.traktId } },
    episode: { season: media.season, number: media.episode },
    progress: p,
  };
}

/** Cache key for a resolution: identity is independent of season/episode. */
export function resolutionCacheKey(media: ParsedMedia): string {
  const mediaType =
    media.season !== undefined || media.episode !== undefined ? "show" : media.mediaType;
  // The TMDB id is the strongest identity — key on it so an id-resolved item
  // never collides with (or is shadowed by) a title-resolved one of the same name.
  if (media.tmdbId !== undefined) return `${mediaType}:tmdb:${media.tmdbId}`;
  return `${mediaType}:${media.title.trim().toLowerCase()}:${media.year ?? ""}`;
}

/**
 * Stable key for a rating/note at a given level. Season/episode numbers are part
 * of the key so each level is tracked independently for one resolved title.
 */
export function reviewKey(
  identity: ResolvedIdentity,
  level: ReviewLevel,
  season?: number,
  episode?: number,
): string {
  const s = level === "season" || level === "episode" ? (season ?? "") : "";
  const e = level === "episode" ? (episode ?? "") : "";
  return `${level}:${identity.traktId}:${s}:${e}`;
}

/**
 * Build a /sync/ratings body for a level. Omit `rating` for the remove endpoint.
 * Returns null when a season/episode level is missing its number(s). Pure.
 */
export function buildRatingBody(
  identity: ResolvedIdentity,
  level: ReviewLevel,
  season: number | undefined,
  episode: number | undefined,
  rating?: number,
): RatingSyncBody | null {
  const r = rating !== undefined ? { rating } : {};
  const ids = { ids: { trakt: identity.traktId } };
  if (level === "movie") return { movies: [{ ...ids, ...r }] };
  if (level === "show") return { shows: [{ ...ids, ...r }] };
  if (season === undefined) return null;
  if (level === "season") return { shows: [{ ...ids, seasons: [{ number: season, ...r }] }] };
  if (episode === undefined) return null;
  return {
    shows: [{ ...ids, seasons: [{ number: season, episodes: [{ number: episode, ...r }] }] }],
  };
}

/** True if the access token is expired (or within `skewSec` of expiring). */
export function isTokenExpired(tokens: TraktTokens, nowSec: number, skewSec = 60): boolean {
  return nowSec >= tokens.created_at + tokens.expires_in - skewSec;
}
