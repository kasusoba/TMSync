import { browser } from "wxt/browser";
import { wetrakrTokens } from "../../storage";
import {
  TokenEndpointError,
  codeChallenge,
  codeVerifier,
  errorDetail,
  launchAuthFlow,
  singleFlight,
} from "../oauth";
import { WETRAKR } from "./config";
import type { WetrakrTokens } from "./types";

const nowSec = () => Math.floor(Date.now() / 1000);

/** Refresh this long before the 7-day access token expires. */
const REFRESH_EARLY_SEC = 24 * 60 * 60;

/** The redirect URI to register in the WeTrakr app (shown in the options page). */
export function getRedirectUri(): string {
  return browser.identity.getRedirectURL();
}

/** Headers every WeTrakr request carries, the auth endpoints included. */
export function baseHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "wetrakr-api-key": WETRAKR.clientId,
    "wetrakr-api-version": WETRAKR.apiVersion,
  };
}

/**
 * Check the authorize callback and return its code. Rejects a wrong `state`
 * (CSRF) first: it comes back on the error path too. Pure.
 */
export function readCallback(redirect: string, state: string): string {
  const params = new URL(redirect).searchParams;
  if (params.get("state") !== state) throw new Error("WeTrakr sign-in failed (state mismatch)");
  const error = params.get("error");
  if (error === "access_denied") throw new Error("WeTrakr sign-in was cancelled");
  if (error)
    throw new Error(params.get("error_description") ?? `WeTrakr sign-in failed (${error})`);
  const code = params.get("code");
  if (!code) throw new Error("WeTrakr returned no code");
  return code;
}

/** POST a token endpoint (JSON, public client, no secret) and read the tokens. */
async function tokenRequest(path: string, body: Record<string, string>): Promise<WetrakrTokens> {
  const res = await fetch(`${WETRAKR.apiBase}${path}`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new TokenEndpointError("WeTrakr", res.status, await errorDetail(res));
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token || !data.refresh_token) throw new Error("WeTrakr returned no token");
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in ?? 7 * 24 * 60 * 60,
    obtained_at: nowSec(),
  };
}

/**
 * Run WeTrakr's authorization code + PKCE flow and persist the tokens. No secret and
 * no backend (constraint #7). A sign-in over an old one logs the old one out.
 */
export async function connect(): Promise<void> {
  if (!WETRAKR.clientId) throw new Error("WeTrakr isn't configured · set WXT_WETRAKR_CLIENT_ID");
  const verifier = codeVerifier();
  const state = crypto.randomUUID();
  const authParams = new URLSearchParams({
    client_id: WETRAKR.clientId,
    redirect_uri: getRedirectUri(),
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
    state,
  });

  const redirect = await launchAuthFlow(
    `${WETRAKR.apiBase}/oauth/authorize?${authParams}`,
    "WeTrakr",
  );
  const code = readCallback(redirect, state);

  // The code is single-use and spent even when the exchange fails: never retried.
  const tokens = await tokenRequest("/oauth/token", {
    client_id: WETRAKR.clientId,
    code,
    code_verifier: verifier,
  });
  const old = await wetrakrTokens.getValue();
  await wetrakrTokens.setValue(tokens);
  if (old) await logout(old);
}

/**
 * Get a new access token. The refresh token ROTATES: the old one is retired after a
 * short grace window, so concurrent callers share one in-flight refresh. A 400 or
 * 401 means the grant is gone (expired after 180 days, revoked, or rotated long
 * ago): clear it so the UI asks to connect again. Anything else keeps it for a
 * later try.
 */
const refresh = singleFlight(async (tokens: WetrakrTokens): Promise<WetrakrTokens | null> => {
  try {
    const next = await tokenRequest("/oauth/token/refresh", {
      refresh_token: tokens.refresh_token,
    });
    await wetrakrTokens.setValue(next);
    return next;
  } catch (e) {
    if (e instanceof TokenEndpointError && e.grantGone) await wetrakrTokens.setValue(null);
    return null;
  }
});

/** A usable access token, refreshed first when it is close to expiry. Null when not
 * connected, or when a refresh failed. */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await wetrakrTokens.getValue();
  if (!tokens) return null;
  const early = Math.min(REFRESH_EARLY_SEC, tokens.expires_in / 2);
  if (nowSec() < tokens.obtained_at + tokens.expires_in - early) return tokens.access_token;
  return (await refresh(tokens))?.access_token ?? null;
}

/**
 * After a 401. If the stored token already changed (another call refreshed it),
 * use that one: refreshing again would spend the rotated refresh token twice.
 */
export async function refreshAfterReject(rejected: string): Promise<string | null> {
  const tokens = await wetrakrTokens.getValue();
  if (!tokens) return null;
  if (tokens.access_token !== rejected) return tokens.access_token;
  return (await refresh(tokens))?.access_token ?? null;
}

/** Connected = a stored grant. A cheap read with no network. */
export async function isConnected(): Promise<boolean> {
  return (await wetrakrTokens.getValue()) !== null;
}

/** Revoke a grant on WeTrakr (POST /oauth/logout). Best effort: offline or an
 * expired access token leaves only the server-side session, which expires. */
async function logout(tokens: WetrakrTokens): Promise<void> {
  try {
    await fetch(`${WETRAKR.apiBase}/oauth/logout`, {
      method: "POST",
      headers: { ...baseHeaders(), Authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
  } catch {
    // offline: the local copy is dropped anyway
  }
}

/** Clear the local tokens, then revoke the grant on WeTrakr. */
export async function disconnect(): Promise<void> {
  const tokens = await wetrakrTokens.getValue();
  await wetrakrTokens.setValue(null);
  if (tokens) await logout(tokens);
}
