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
