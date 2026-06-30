import { TMDB } from "@/config";
import { tmdbPosterCache } from "@/lib/storage";

/**
 * A TMDB poster URL for a Trakt item, for the Discord RP large image only
 * (docs/DISCORD-RP.md). Optional: returns undefined when no `WXT_TMDB_API_KEY`
 * is bundled or nothing is found, so RP just falls back to the brand asset. The
 * result (incl. a confirmed "no poster" = null) is cached by `${type}:${tmdbId}`.
 * TMDB is display-only here — never resolution/tracking (constraint #1).
 */
export async function tmdbPoster(
  tmdbId: number | undefined,
  type: "movie" | "show",
): Promise<string | undefined> {
  if (tmdbId === undefined || !TMDB.apiKey) return undefined;
  const cacheKey = `${type}:${tmdbId}`;
  const cache = await tmdbPosterCache.getValue();
  if (cacheKey in cache) return cache[cacheKey] ?? undefined;
  try {
    const path = type === "movie" ? "movie" : "tv";
    const res = await fetch(`${TMDB.apiBase}/3/${path}/${tmdbId}?api_key=${TMDB.apiKey}`);
    if (!res.ok) return undefined; // don't cache transient failures
    const data = (await res.json()) as { poster_path?: string | null };
    const url = data.poster_path ? `${TMDB.imageBase}/w500${data.poster_path}` : null;
    await tmdbPosterCache.setValue({ ...cache, [cacheKey]: url });
    return url ?? undefined;
  } catch {
    return undefined;
  }
}
