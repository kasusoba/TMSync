/**
 * Static WeTrakr configuration. The client id comes from `.env`
 * (`WXT_WETRAKR_CLIENT_ID`, inlined at build). It is the app key WeTrakr expects in
 * the `wetrakr-api-key` header on every request, and it is public.
 *
 * Sign-in is authorization code + PKCE (S256 only) with no client secret: WeTrakr's
 * terms forbid a secret in an app users install. One app registers both browsers'
 * redirect URIs. The API sends no CORS headers, so its origin is an optional host
 * permission asked on Connect (`TRACKER_INFO.hostAccess`, docs/TRACKERS.md).
 */
export const WETRAKR = {
  clientId: import.meta.env.WXT_WETRAKR_CLIENT_ID,
  /** API root. The authorize page and the token endpoints live here too. */
  apiBase: "https://api.wetrakr.com",
  /** The site, for the item links WeTrakr's terms require. */
  siteBase: "https://wetrakr.com",
  /** The `wetrakr-api-version` header. */
  apiVersion: "1",
} as const;
