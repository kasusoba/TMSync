/**
 * Static MyAnimeList configuration. The client id comes from `.env`
 * (`WXT_MAL_CLIENT_ID`, inlined at build).
 *
 * The MAL app is registered as type "Other": a public client with NO secret, so
 * sign-in is authorization code + PKCE and nothing secret ships in the bundle.
 * MAL supports only the `plain` PKCE method (docs/TRACKERS-PLAN.md, "MAL API
 * facts"). One app registers both browsers' redirect URIs, so the same id serves
 * Chrome and Firefox.
 */
export const MAL = {
  clientId: import.meta.env.WXT_MAL_CLIENT_ID,
  /** OAuth authorize page (opened via launchWebAuthFlow). */
  authBase: "https://myanimelist.net/v1/oauth2/authorize",
  /** Token endpoint (code or refresh token → tokens). Form-urlencoded. */
  tokenBase: "https://myanimelist.net/v1/oauth2/token",
  /** REST API root. */
  apiBase: "https://api.myanimelist.net/v2",
} as const;

/**
 * The origins MAL calls need. They are NOT install-time host permissions: the UI
 * requests them on the Connect click (a user gesture), inside the existing
 * `optional_host_permissions`. MAL sends no CORS headers, so without the grant
 * every call fails and the adapter degrades to "not connected".
 */
export const MAL_ORIGINS = ["https://myanimelist.net/*", "https://api.myanimelist.net/*"];
