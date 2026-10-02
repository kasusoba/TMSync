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

/** The project's repository: source code, issues, and the recipe format docs. */
export const REPO_URL = "https://github.com/kasusoba/TMSync";

/**
 * Recipe sources: user-added URLs of recipe files (the extension ships no sites).
 * The fetch is a plain public GET, no watch data leaves the client (constraint #6).
 */
export const SOURCES = {
  /** Re-fetch a source at most this often. */
  refreshMs: 12 * 60 * 60 * 1000,
  /** A larger file is refused, so a hostile source cannot fill storage. */
  maxBytes: 1_000_000,
} as const;

/**
 * The TMDB<->AniList crosswalk used by the multi-track fan-out (docs/ARCHITECTURE.md).
 * Fetched from this repo's CDN rather than bundled: the rows are
 * ~300 KB, and upstream (Fribb/anime-lists) regenerates weekly, so a bundled copy
 * would both bloat the service worker and go stale between releases. A plain public
 * GET, no watch data leaves the client (constraint #6).
 */
export const ANIME_MAP = {
  url:
    import.meta.env.WXT_ANIME_MAP_URL ||
    "https://raw.githubusercontent.com/kasusoba/TMSync/main/recipes/anime-map.json",
  /** Re-fetch at most this often. Upstream updates weekly, so daily is generous. */
  refreshMs: 24 * 60 * 60 * 1000,
} as const;
