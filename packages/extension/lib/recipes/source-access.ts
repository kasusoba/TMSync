import { browser } from "wxt/browser";

/**
 * Hosts that serve raw files with `Access-Control-Allow-Origin: *`, so the
 * extension reads them with no host permission. `raw.githubusercontent.com` is
 * also in the install manifest (for the anime map).
 */
const OPEN_HOSTS = new Set([
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "cdn.jsdelivr.net",
]);

/** A source URL from what the user typed: https only, or null. */
export function parseSourceUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** The permission pattern a source URL needs, or null when its host is open. */
function sourcePattern(url: string): string | null {
  const { hostname, origin } = new URL(url);
  return OPEN_HOSTS.has(hostname) ? null : `${origin}/*`;
}

/**
 * Ask for read access to a source's host when it needs it. Call it first in the
 * click handler, before any other await, so the browser still sees the gesture.
 */
export async function requestSourceAccess(url: string): Promise<boolean> {
  const pattern = sourcePattern(url);
  if (!pattern) return true;
  return browser.permissions.request({ origins: [pattern] });
}

/** Give back a removed source's host access, unless something else still uses it. */
export async function releaseSourceAccess(url: string, stillUsed: string[]): Promise<void> {
  const pattern = sourcePattern(url);
  if (!pattern || stillUsed.some((u) => sourcePattern(u) === pattern)) return;
  await browser.permissions.remove({ origins: [pattern] }).catch(() => false);
}

/** True when a source's host needs access that TMSync does not hold yet (a source
 *  that came from a backup or another device, which never went through Add). */
export async function needsSourceAccess(url: string): Promise<boolean> {
  const pattern = sourcePattern(url);
  if (!pattern) return false;
  return !(await browser.permissions.contains({ origins: [pattern] }).catch(() => false));
}
