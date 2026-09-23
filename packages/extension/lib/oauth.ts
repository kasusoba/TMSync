import { browser } from "wxt/browser";

/**
 * Wrapper around `identity.launchWebAuthFlow` that turns the browser's opaque
 * load-failure into an actionable message.
 *
 * When the isolated auth window can't render the provider's page, Chrome rejects
 * with the bare string "Authorization page could not be loaded." The most common
 * cause is simply that the user isn't signed in to the provider in this browser,
 * so the authorize URL bounces to a sign-in/challenge page the ephemeral window
 * can't complete. We rewrite only that case; a user-cancelled flow (a different
 * rejection message) is left untouched so the popup doesn't nag them to sign in
 * when they just closed the window.
 *
 * @param url       The authorize URL to open interactively.
 * @param provider  Human-readable provider name, e.g. "Trakt" / "AniList".
 * @returns The final redirect URL (with the auth code in its query/fragment).
 */
export async function launchAuthFlow(url: string, provider: string): Promise<string> {
  let redirect: string | undefined;
  try {
    redirect = await browser.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Chrome: "Authorization page could not be loaded." (Firefox phrasing varies
    // but also contains "load"). Match loosely and rewrite into a next step.
    if (/could not be loaded|page could not be loaded/i.test(msg)) {
      throw new Error(
        `Couldn't open the ${provider} sign-in page. Sign in to ${provider} in this browser first, then try connecting again.`,
      );
    }
    throw e;
  }
  if (!redirect) throw new Error("OAuth flow was cancelled");
  return redirect;
}

/** The first 160 characters of an error response's body ("" if unreadable). */
export async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()).trim().slice(0, 160);
  } catch {
    return "";
  }
}

/** A token endpoint answered with an error status. 400 and 401 mean the grant is
 * gone; anything else (a rate limit, a server error) is worth a later try. */
export class TokenEndpointError extends Error {
  constructor(
    provider: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider} token endpoint returned ${status}${detail ? `: ${detail}` : ""}`);
  }

  /** Whether the grant is revoked or expired, so the stored tokens must go. */
  get grantGone(): boolean {
    return this.status === 400 || this.status === 401;
  }
}

/**
 * POST a public client's token request (form-urlencoded, `client_id`, no secret)
 * and return the JSON body. Throws `TokenEndpointError` on an error status.
 */
export async function postTokenForm(
  url: string,
  provider: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new TokenEndpointError(provider, res.status, await errorDetail(res));
  return (await res.json()) as Record<string, unknown>;
}

/** Bytes as base64url with no padding (PKCE verifiers and challenges). */
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Share one in-flight call between concurrent callers: two API calls that hit an
 * expired token then spend the refresh token once. Not session state: the promise
 * only lives for the duration of one request (constraint #4).
 */
export function singleFlight<A, T>(fn: (arg: A) => Promise<T>): (arg: A) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (arg) => {
    inFlight ??= fn(arg).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
