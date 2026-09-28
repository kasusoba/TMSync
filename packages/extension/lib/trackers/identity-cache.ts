/**
 * Freshness for cached cour identities (AniList, MAL). A match with a known episode
 * total never changes, so it stays cached. A match with an unknown total (a show
 * still airing) goes stale after a day: the total arrives when the show ends, and
 * without it the final episode never completes the entry and the numbering
 * guardrail (`episode > total`) never fires.
 */

/** How long a cached identity with an unknown total is trusted. */
export const OPEN_TOTAL_TTL_MS = 24 * 60 * 60 * 1000;

/** A cached identity, stamped with when it was stored (ms). Entries stored before
 * the stamp existed have none, so an open one among them is refetched once. */
export type Cached<T> = T & { at?: number };

/** Stamp an identity for the cache. Pure. */
export function stamp<T extends object>(identity: T, now = Date.now()): Cached<T> {
  return { ...identity, at: now };
}

/** The cached identity without its stamp, or undefined when it is missing or its
 * unknown total is stale. Pure. */
export function freshHit<T extends { episodes: number | null }>(
  hit: Cached<T> | undefined,
  now = Date.now(),
): T | undefined {
  if (!hit) return undefined;
  if (hit.episodes === null && now - (hit.at ?? 0) >= OPEN_TOTAL_TTL_MS) return undefined;
  const { at: _at, ...identity } = hit;
  return identity as T;
}
