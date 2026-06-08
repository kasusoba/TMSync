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
 * Phase-1 recipe distribution: a versioned JSON list fetched from the repo/CDN
 * (no backend — constraint #7), contributed by PR. Override the URL with
 * WXT_RECIPES_URL. The fetch is a plain public GET — no watch data leaves the
 * client (constraint #6). The CDN origin needs a matching host permission.
 */
export const RECIPES = {
  url:
    import.meta.env.WXT_RECIPES_URL ||
    "https://raw.githubusercontent.com/kasusoba/TMSync/main/recipes/index.json",
  /** Re-fetch at most this often. */
  refreshMs: 12 * 60 * 60 * 1000,
  /** Where contributors open a PR to add a site. */
  contributeUrl: import.meta.env.WXT_RECIPES_REPO || "https://github.com/kasusoba/TMSync",
} as const;
