import { browser } from "wxt/browser";
import {
  TokenEndpointError,
  base64url,
  launchAuthFlow,
  postTokenForm,
  singleFlight,
} from "../oauth";
import { simklTokens } from "../storage";
import { SIMKL } from "./config";
import type { SimklTokens } from "./types";

const nowSec = () => Math.floor(Date.now() / 1000);

/** Refresh this long before the access token expires. Simkl suggests about a day. */
const REFRESH_EARLY_SEC = 24 * 60 * 60;

/** The redirect URI to register in the Simkl app (shown in the options page). */
export function getRedirectUri(): string {
  return browser.identity.getRedirectURL();
}

/** A PKCE code verifier: 32 random bytes as base64url (43 characters), new per sign-in. */
export function codeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 challenge for a verifier: base64url(SHA-256(verifier)). Simkl rejects `plain`. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * Check the authorize callback and return its code. Rejects a wrong `state`
 * (CSRF) and a wrong `iss` (mix-up: TMSync talks to several authorization
 * servers). Both come back on the error path too, so they are checked first. Pure.
 */
export function readCallback(redirect: string, state: string): string {
  const params = new URL(redirect).searchParams;
  if (params.get("iss") !== SIMKL.issuer) {
    throw new Error("Simkl sign-in failed (the response did not come from Simkl)");
  }
  if (params.get("state") !== state) throw new Error("Simkl sign-in failed (state mismatch)");
  const error = params.get("error");
  if (error === "access_denied") throw new Error("Simkl sign-in was cancelled");
  if (error) throw new Error(params.get("error_description") ?? `Simkl sign-in failed (${error})`);
  const code = params.get("code");
  if (!code) throw new Error("Simkl returned no code");
  return code;
}

/** POST the token endpoint (form-urlencoded, public client: `client_id`, no secret). */
async function tokenRequest(
  params: Record<string, string>,
): Promise<{ tokens: Omit<SimklTokens, "refresh_token">; refresh?: string; scope?: string }> {
  const data = (await postTokenForm(SIMKL.tokenUrl, "Simkl", {
    client_id: SIMKL.clientId,
    ...params,
  })) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!data.access_token) throw new Error("Simkl returned no token");
  return {
    tokens: {
      access_token: data.access_token,
      expires_in: data.expires_in ?? 7 * 24 * 60 * 60,
      obtained_at: nowSec(),
    },
    refresh: data.refresh_token,
    scope: data.scope,
  };
}

/** Whether a granted scope string allows writes. A typo or a missing scope in the
 * request gives a read-only token with no error, so the grant must be checked. Pure. */
export function canWrite(scope: string | undefined): boolean {
  return (scope ?? "").split(/\s+/).includes("media:write");
}

/**
 * Run Simkl's authorization code + PKCE flow and persist the tokens. No secret and
 * no backend (constraint #7). `redirect_uri` goes on both legs, character for
 * character: Simkl compares it as a plain string.
 */
export async function connect(): Promise<void> {
  if (!SIMKL.clientId) throw new Error("Simkl isn't configured · set WXT_SIMKL_CLIENT_ID");
  const redirectUri = getRedirectUri();
  const verifier = codeVerifier();
  const state = crypto.randomUUID();
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: SIMKL.clientId,
    redirect_uri: redirectUri,
    scope: SIMKL.scope,
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
  });

  const redirect = await launchAuthFlow(`${SIMKL.authBase}?${authParams}`, "Simkl");
  const code = readCallback(redirect, state);

  // The code is spent even when the exchange fails, so this is never retried.
  const out = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (!out.refresh) throw new Error("Simkl returned no refresh token");
  // No scope in the reply means the requested scope was granted (RFC 6749 §5.1).
  if (!canWrite(out.scope ?? SIMKL.scope)) {
    await revoke(out.refresh);
    throw new Error("Simkl gave read-only access, so TMSync can't record your watches");
  }
  const old = await simklTokens.getValue();
  await simklTokens.setValue({ ...out.tokens, refresh_token: out.refresh });
  const stale = staleRefresh(old, out.refresh);
  if (stale) await revoke(stale);
}

/**
 * The refresh token to revoke after a re-connect, or null. A new grant replaces
 * the old one, so the old one should not linger. But Simkl's refresh token does not
 * rotate, so it may hand the same grant back, and revoking that would cut off the
 * sign-in that just finished. Pure.
 */
export function staleRefresh(old: SimklTokens | null, fresh: string): string | null {
  return old && old.refresh_token !== fresh ? old.refresh_token : null;
}

/**
 * Get a new access token. A refresh kills the previous access token at once, so
 * concurrent callers share one in-flight refresh (never two refreshes of one
 * grant). The refresh token does not rotate; keep ours if the response omits it.
 * A 400 or 401 means the grant is gone (unused for 180 days, or revoked): clear it
 * so the UI asks to connect again. Anything else (a rate limit, a network or server
 * error) keeps it for a later try.
 */
const refresh = singleFlight(async (tokens: SimklTokens): Promise<SimklTokens | null> => {
  try {
    const out = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    const next = { ...out.tokens, refresh_token: out.refresh ?? tokens.refresh_token };
    await simklTokens.setValue(next);
    return next;
  } catch (e) {
    if (e instanceof TokenEndpointError && e.grantGone) await simklTokens.setValue(null);
    return null;
  }
});

/** A usable access token, refreshed first when it is close to expiry. Null when not
 * connected, or when a refresh failed. */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await simklTokens.getValue();
  if (!tokens) return null;
  // Early by a day, or by half the lifetime for a short-lived token, so a token
  // shorter than a day is not refreshed on every call (each one costs quota).
  const early = Math.min(REFRESH_EARLY_SEC, tokens.expires_in / 2);
  if (nowSec() < tokens.obtained_at + tokens.expires_in - early) {
    return tokens.access_token;
  }
  return (await refresh(tokens))?.access_token ?? null;
}

/**
 * After a 401. If the stored token already changed (another call refreshed it),
 * use that one: refreshing again would cut it off. Otherwise refresh.
 */
export async function refreshAfterReject(rejected: string): Promise<string | null> {
  const tokens = await simklTokens.getValue();
  if (!tokens) return null;
  if (tokens.access_token !== rejected) return tokens.access_token;
  return (await refresh(tokens))?.access_token ?? null;
}

/** Forget a grant that Simkl rejects even right after a refresh, so the UI asks
 * to connect again instead of showing a connection that can't work. */
export async function forgetGrant(): Promise<void> {
  await simklTokens.setValue(null);
}

/** Connected = a stored grant. A cheap read with no network. */
export async function isConnected(): Promise<boolean> {
  return (await simklTokens.getValue()) !== null;
}

/** Revoke a grant (either token revokes both). Best effort: the endpoint always
 * answers 200, so there is nothing to check. */
async function revoke(token: string): Promise<void> {
  try {
    await fetch(SIMKL.revokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: SIMKL.clientId, token }),
    });
  } catch {
    // offline: the local copy is dropped anyway
  }
}

/** Revoke the grant on Simkl, then clear the local tokens. */
export async function disconnect(): Promise<void> {
  const tokens = await simklTokens.getValue();
  await simklTokens.setValue(null);
  if (tokens) await revoke(tokens.refresh_token);
}
