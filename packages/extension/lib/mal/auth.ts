import { browser } from "wxt/browser";
import {
  TokenEndpointError,
  base64url,
  launchAuthFlow,
  postTokenForm,
  singleFlight,
} from "../oauth";
import { malTokens } from "../storage";
import { MAL } from "./config";
import type { MalTokens } from "./types";

const nowSec = () => Math.floor(Date.now() / 1000);

/** The redirect URI to register in the MAL app (shown in the options page). */
export function getRedirectUri(): string {
  return browser.identity.getRedirectURL();
}

/**
 * A PKCE code verifier: 64 random bytes as base64url, 86 unreserved characters
 * (MAL wants 43 to 128), new for every sign-in. MAL supports only the `plain`
 * method, so the challenge sent to the authorize page IS this verifier.
 */
export function codeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(64)));
}

/** POST the token endpoint (form-urlencoded, public client: `client_id`, no secret). */
async function tokenRequest(params: Record<string, string>): Promise<MalTokens> {
  const data = (await postTokenForm(MAL.tokenBase, "MyAnimeList", {
    client_id: MAL.clientId,
    ...params,
  })) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token || !data.refresh_token) {
    throw new Error("MyAnimeList returned no token");
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // The docs say one hour but their own example is about 28 days: trust the
    // server. Fall back to the documented hour if it ever omits the field.
    expires_in: data.expires_in ?? 3600,
    obtained_at: nowSec(),
  };
}

/**
 * Run MAL's authorization code + PKCE flow and persist the tokens. No secret and
 * no backend (constraint #7): the app is a public "Other" client. `redirect_uri`
 * is sent on both legs because the app registers two (Chrome and Firefox), and MAL
 * then requires an exact match.
 */
export async function connect(): Promise<MalTokens> {
  if (!MAL.clientId) {
    throw new Error("MyAnimeList isn't configured · set WXT_MAL_CLIENT_ID");
  }
  const redirectUri = getRedirectUri();
  const verifier = codeVerifier();
  const state = crypto.randomUUID();
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: MAL.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: verifier,
    code_challenge_method: "plain",
  });

  const redirect = await launchAuthFlow(`${MAL.authBase}?${authParams}`, "MyAnimeList");

  const params = new URL(redirect).searchParams;
  const code = params.get("code");
  if (!code) {
    throw new Error(params.get("error_description") ?? params.get("error") ?? "No code returned");
  }
  if (params.get("state") !== state) throw new Error("MyAnimeList sign-in failed (state mismatch)");

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  await malTokens.setValue(tokens);
  return tokens;
}

/**
 * Trade the refresh token for a new token set. MAL rotates the refresh token, so
 * the new set replaces the old. A 400 or 401 means the grant is gone (expired
 * after a month unused, or revoked): clear it so the UI asks to connect again.
 * Anything else (a rate limit, a network or server error) keeps the tokens for a
 * later try.
 */
const refresh = singleFlight(async (tokens: MalTokens): Promise<MalTokens | null> => {
  try {
    const next = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    await malTokens.setValue(next);
    return next;
  } catch (e) {
    if (e instanceof TokenEndpointError && e.grantGone) await malTokens.setValue(null);
    return null;
  }
});

/** A usable access token, refreshing it first when it is about to expire. Null
 * when not connected, or when a refresh failed. */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await malTokens.getValue();
  if (!tokens) return null;
  if (nowSec() < tokens.obtained_at + tokens.expires_in - 60) return tokens.access_token;
  return (await refresh(tokens))?.access_token ?? null;
}

/** Refresh after the API rejected the access token (401) before its local expiry. */
export async function refreshAfterReject(): Promise<string | null> {
  const tokens = await malTokens.getValue();
  if (!tokens) return null;
  return (await refresh(tokens))?.access_token ?? null;
}

/** Connected = a stored grant. A cheap read with no network: an expired access
 * token still counts, since the next call refreshes it. */
export async function isConnected(): Promise<boolean> {
  return (await malTokens.getValue()) !== null;
}

/** Clear the local tokens (MAL has no revoke endpoint). */
export async function disconnect(): Promise<void> {
  await malTokens.setValue(null);
}
