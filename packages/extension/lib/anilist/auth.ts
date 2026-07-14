import { browser } from "wxt/browser";
import { launchAuthFlow } from "../oauth";
import { anilistTokens } from "../storage";
import { ANILIST } from "./config";
import type { AniListTokens } from "./types";

const nowSec = () => Math.floor(Date.now() / 1000);

/** The redirect URI to register in the AniList app (shown in the options page). */
export function getRedirectUri(): string {
  return browser.identity.getRedirectURL();
}

/**
 * Run AniList's **Authorization Code grant** and persist the token. AniList no
 * longer supports the implicit grant (its authorize endpoint returns
 * `unsupported_grant_type` for `response_type=token`), so we mirror the Trakt
 * flow: get a `code` on the redirect, then exchange it at `/oauth/token` with the
 * bundled client secret. No backend (constraint #7) — same model as Trakt.
 */
export async function connect(): Promise<AniListTokens> {
  if (!ANILIST.clientId || !ANILIST.clientSecret) {
    throw new Error(
      "AniList isn't configured · set WXT_ANILIST_CLIENT_ID and WXT_ANILIST_CLIENT_SECRET",
    );
  }
  const redirectUri = getRedirectUri();
  const authParams = new URLSearchParams({
    client_id: ANILIST.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
  });
  const authUrl = `${ANILIST.authBase}?${authParams.toString()}`;

  const redirect = await launchAuthFlow(authUrl, "AniList");

  // The code is in the query (authorization code grant), not the fragment.
  const params = new URL(redirect).searchParams;
  const code = params.get("code");
  if (!code) {
    throw new Error(
      params.get("error_description") ?? params.get("error") ?? "No authorization code returned",
    );
  }

  const res = await fetch(ANILIST.tokenBase, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANILIST.clientId,
      client_secret: ANILIST.clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 160);
    } catch {
      // ignore unreadable body
    }
    throw new Error(`AniList token endpoint returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  const tokens: AniListTokens = {
    access_token: data.access_token,
    token_type: "Bearer",
    expires_in: data.expires_in ?? 31536000,
    refresh_token: data.refresh_token,
    obtained_at: nowSec(),
  };
  await anilistTokens.setValue(tokens);
  return tokens;
}

/** A non-expired access token, or null. Implicit grant has no refresh — expiry ⇒ reconnect. */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await anilistTokens.getValue();
  if (!tokens) return null;
  if (nowSec() >= tokens.obtained_at + tokens.expires_in - 60) {
    await anilistTokens.setValue(null); // expired — force reconnect
    return null;
  }
  return tokens.access_token;
}

export async function isConnected(): Promise<boolean> {
  return (await getValidAccessToken()) !== null;
}

/** Clear the local token (AniList has no implicit-grant revoke endpoint). */
export async function disconnect(): Promise<void> {
  await anilistTokens.setValue(null);
}
