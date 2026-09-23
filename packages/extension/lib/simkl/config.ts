/**
 * Static Simkl configuration. The client id comes from `.env`
 * (`WXT_SIMKL_CLIENT_ID`, inlined at build). Simkl says a V2 client id is public
 * and safe to ship.
 *
 * The app is an AUTH V2 "Mobile, desktop & browser apps" registration: no client
 * secret, sign-in is authorization code + PKCE (S256 only). One app registers both
 * browsers' redirect URIs. api.simkl.com answers CORS, so unlike MAL no host
 * permission is needed (docs/TRACKERS-PLAN.md, "Step 2").
 */
export const SIMKL = {
  clientId: import.meta.env.WXT_SIMKL_CLIENT_ID,
  /** Consent page (opened via launchWebAuthFlow). The only endpoint on simkl.com. */
  authBase: "https://simkl.com/oauth2/authorize",
  /** Token exchange and refresh. Form-urlencoded. */
  tokenUrl: "https://api.simkl.com/oauth2/token",
  /** Revokes the whole grant (either token). Always answers 200. */
  revokeUrl: "https://api.simkl.com/oauth2/revoke",
  /** REST API root. */
  apiBase: "https://api.simkl.com",
  /** The `iss` value the authorize callback must carry (mix-up defence). */
  issuer: "https://simkl.com",
  /** Both scopes: without `media:write` the token is read-only. */
  scope: "media:read media:write",
  /** The `app-name` query parameter Simkl asks every request to carry. */
  appName: "tmsync",
} as const;

/** Simkl allows one scrobble call per user per 20 s; a second one inside the
 * window fails with `400 RATE_LIMIT`. */
export const SCROBBLE_LOCK_MS = 20_000;
