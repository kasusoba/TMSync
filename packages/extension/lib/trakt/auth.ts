import { TRAKT } from "@/config";
import { launchAuthFlow } from "@/lib/oauth";
import { traktTokens } from "@/lib/storage";
import { browser } from "wxt/browser";
import type { TraktTokens } from "./types";
import { isTokenExpired } from "./util";

const nowSec = () => Math.floor(Date.now() / 1000);

/** The redirect URI to register in the Trakt app (shown in the popup). */
export function getRedirectUri(): string {
  return browser.identity.getRedirectURL();
}

async function postToken(body: Record<string, string>): Promise<TraktTokens> {
  const res = await fetch(`${TRAKT.apiBase}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": TRAKT.userAgent },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Trakt token endpoint returned ${res.status}`);
  return (await res.json()) as TraktTokens;
}

/** Run the OAuth Authorization Code flow and persist the tokens. */
export async function connect(): Promise<TraktTokens> {
  const redirectUri = getRedirectUri();
  const state = crypto.randomUUID();
  const authUrl =
    `${TRAKT.authBase}/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(TRAKT.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  const redirect = await launchAuthFlow(authUrl, "Trakt");

  const params = new URL(redirect).searchParams;
  if (params.get("state") !== state) throw new Error("OAuth state mismatch");
  const code = params.get("code");
  if (!code) throw new Error(params.get("error") ?? "No authorization code returned");

  const tokens = await postToken({
    code,
    client_id: TRAKT.clientId,
    client_secret: TRAKT.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  await traktTokens.setValue(tokens);
  return tokens;
}

/** Rotate the access token using the refresh token. Clears tokens on failure. */
export async function refreshTokens(): Promise<TraktTokens | null> {
  const current = await traktTokens.getValue();
  if (!current) return null;
  try {
    const next = await postToken({
      refresh_token: current.refresh_token,
      client_id: TRAKT.clientId,
      client_secret: TRAKT.clientSecret,
      redirect_uri: getRedirectUri(),
      grant_type: "refresh_token",
    });
    await traktTokens.setValue(next);
    return next;
  } catch {
    await traktTokens.setValue(null); // force re-auth
    return null;
  }
}

/** A non-expired access token, refreshing if needed. null = not connected. */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await traktTokens.getValue();
  if (!tokens) return null;
  if (!isTokenExpired(tokens, nowSec())) return tokens.access_token;
  const refreshed = await refreshTokens();
  return refreshed?.access_token ?? null;
}

export async function isConnected(): Promise<boolean> {
  return (await traktTokens.getValue()) !== null;
}

/** Best-effort token revocation + local clear. */
export async function disconnect(): Promise<void> {
  const tokens = await traktTokens.getValue();
  if (tokens) {
    try {
      await fetch(`${TRAKT.apiBase}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": TRAKT.userAgent },
        body: JSON.stringify({
          token: tokens.access_token,
          client_id: TRAKT.clientId,
          client_secret: TRAKT.clientSecret,
        }),
      });
    } catch {
      // ignore network errors on revoke; we still clear locally
    }
  }
  await traktTokens.setValue(null);
}
