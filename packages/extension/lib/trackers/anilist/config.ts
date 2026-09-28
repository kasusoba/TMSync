/**
 * Static AniList configuration. Credentials come from `.env` (WXT_* vars, inlined
 * at build).
 *
 * NOTE: AniList **removed the implicit grant** — its authorize endpoint returns
 * `unsupported_grant_type` for `response_type=token` (verified 2026-06). So we use
 * the **Authorization Code grant** (`response_type=code` → exchange at /oauth/token
 * with the client secret), exactly like the Trakt adapter. This still needs NO
 * backend (constraint #7 holds): the secret is bundled, same as Trakt's. The
 * trade-off vs the old plan is just a bundled secret instead of none.
 */
// AniList allows only ONE redirect URL per app, and each browser's
// launchWebAuthFlow redirect is fixed by the browser and differs:
//   Chrome/Edge → https://<key-derived-id>.chromiumapp.org/
//   Firefox     → https://<gecko-id-derived>.extensions.allizom.org/
// So one AniList app can't cover both. Firefox uses its OWN app when its
// credentials are provided (falling back to the shared app so a Firefox build
// still works before the second app exists). Trakt needs no such split — it
// accepts multiple redirect URIs on a single app.
const anilistCreds = import.meta.env.FIREFOX
  ? {
      clientId:
        import.meta.env.WXT_ANILIST_CLIENT_ID_FIREFOX || import.meta.env.WXT_ANILIST_CLIENT_ID,
      clientSecret:
        import.meta.env.WXT_ANILIST_CLIENT_SECRET_FIREFOX ||
        import.meta.env.WXT_ANILIST_CLIENT_SECRET,
    }
  : {
      clientId: import.meta.env.WXT_ANILIST_CLIENT_ID,
      clientSecret: import.meta.env.WXT_ANILIST_CLIENT_SECRET,
    };

export const ANILIST = {
  clientId: anilistCreds.clientId,
  clientSecret: anilistCreds.clientSecret,
  /** OAuth authorize page (opened via launchWebAuthFlow). */
  authBase: "https://anilist.co/api/v2/oauth/authorize",
  /** Token-exchange endpoint (code → access token). Needs an anilist.co host permission. */
  tokenBase: "https://anilist.co/api/v2/oauth/token",
  /** The single GraphQL endpoint (one POST for everything). Needs a host permission. */
  apiBase: "https://graphql.anilist.co",
} as const;
