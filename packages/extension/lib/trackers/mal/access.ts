import { browser } from "wxt/browser";
import { MAL_ORIGINS } from "./config";

/**
 * Ask for MAL host access. Call it FIRST in a Connect click handler, before any
 * `await`: the browser only shows the prompt during a user gesture. The origins sit
 * inside the manifest's `optional_host_permissions`, so nothing is granted at
 * install (constraint #5).
 */
export function requestMalAccess(): Promise<boolean> {
  return browser.permissions.request({ origins: MAL_ORIGINS });
}

/** Whether a set of newly granted origins is the MAL grant. */
export function isMalGrant(origins: string[] | undefined): boolean {
  return MAL_ORIGINS.every((o) => origins?.includes(o));
}

/** Whether MAL host access is granted (every MAL call needs it: no CORS headers). */
export function hasMalAccess(): Promise<boolean> {
  return browser.permissions.contains({ origins: MAL_ORIGINS });
}
