/**
 * Static Trakt configuration. Credentials come from `.env` (WXT_* vars, inlined
 * at build — see .env for the secret-in-bundle note). Endpoints/headers per the
 * Trakt API docs.
 */
export const TRAKT = {
  clientId: import.meta.env.WXT_TRAKT_CLIENT_ID,
  clientSecret: import.meta.env.WXT_TRAKT_CLIENT_SECRET,
  /** API host (data). Requires a matching host permission in the manifest. */
  apiBase: "https://api.trakt.tv",
  /** Web host (OAuth authorize page, opened via launchWebAuthFlow). */
  authBase: "https://trakt.tv",
  apiVersion: "2",
  /** Sent on every request. Browsers may drop User-Agent on fetch; harmless if so. */
  userAgent: "tmsync/1.0",
} as const;

/**
 * TMDB is used for ONE thing only: fetching a poster image URL for Discord Rich
 * Presence (experimental — docs/DISCORD-RP.md). It is NOT a tracker and never
 * touches resolution/scrobbling (constraint #1: Trakt + AniList only; "TMDB-as-
 * tracker" is explicitly forbidden). Optional — without a key, RP falls back to
 * the bundled brand art. AniList posters come free from its own API (no key).
 */
export const TMDB = {
  apiKey: import.meta.env.WXT_TMDB_API_KEY,
  apiBase: "https://api.themoviedb.org",
  /** Image CDN — the URL is handed to Discord to render; we never fetch it. */
  imageBase: "https://image.tmdb.org/t/p",
} as const;

/**
 * Phase-1 recipe distribution: a versioned JSON list fetched from the repo/CDN
 * (no backend — constraint #7), contributed by PR. Override the URL with
 * WXT_RECIPES_URL. The fetch is a plain public GET — no watch data leaves the
 * client (constraint #6). The CDN origin needs a matching host permission.
 */
export const RECIPES = {
  url:
    import.meta.env.WXT_RECIPES_URL ||
    "https://raw.githubusercontent.com/kasusoba/TMSync/main/recipes/index.json",
  /** The separate anime (AniList) recipe list — kept apart from the public Trakt
   * list (CLAUDE.md), but still fetched so contributed anime recipes reach the
   * library, not only the bundled seed. */
  animeUrl:
    import.meta.env.WXT_RECIPES_ANIME_URL ||
    "https://raw.githubusercontent.com/kasusoba/TMSync/main/recipes/anime/index.json",
  /** Re-fetch at most this often. */
  refreshMs: 12 * 60 * 60 * 1000,
  /** Where contributors open a PR to add a site. */
  contributeUrl: import.meta.env.WXT_RECIPES_REPO || "https://github.com/kasusoba/TMSync",
} as const;
