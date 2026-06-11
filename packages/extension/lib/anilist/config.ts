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
export const ANILIST = {
  clientId: import.meta.env.WXT_ANILIST_CLIENT_ID,
  clientSecret: import.meta.env.WXT_ANILIST_CLIENT_SECRET,
  /** OAuth authorize page (opened via launchWebAuthFlow). */
  authBase: "https://anilist.co/api/v2/oauth/authorize",
  /** Token-exchange endpoint (code → access token). Needs an anilist.co host permission. */
  tokenBase: "https://anilist.co/api/v2/oauth/token",
  /** The single GraphQL endpoint (one POST for everything). Needs a host permission. */
  apiBase: "https://graphql.anilist.co",
} as const;
