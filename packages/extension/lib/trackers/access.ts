import { browser } from "wxt/browser";
import { TRACKER_INFO, type Tracker } from "./types";

/**
 * Host access for trackers whose API sends no CORS headers (`TRACKER_INFO.hostAccess`).
 * The origins sit inside the manifest's `optional_host_permissions`, so nothing is
 * granted at install (constraint #5). A tracker without `hostAccess` always has access.
 */

const origins = (tracker: Tracker): string[] => [
  ...(TRACKER_INFO[tracker].hostAccess?.origins ?? []),
];

/** Whether the tracker needs a host grant before it can connect. */
export const needsHostAccess = (tracker: Tracker): boolean => origins(tracker).length > 0;

/**
 * Ask for the tracker's host access. Call it FIRST in a Connect click handler,
 * before any `await`: the browser only shows the prompt during a user gesture.
 */
export function requestTrackerAccess(tracker: Tracker): Promise<boolean> {
  if (!needsHostAccess(tracker)) return Promise.resolve(true);
  return browser.permissions.request({ origins: origins(tracker) });
}

/** Whether the tracker's host access is granted. */
export function hasTrackerAccess(tracker: Tracker): Promise<boolean> {
  if (!needsHostAccess(tracker)) return Promise.resolve(true);
  return browser.permissions.contains({ origins: origins(tracker) });
}

/** Whether a set of newly granted origins is this tracker's grant. */
export function isTrackerGrant(tracker: Tracker, granted: string[] | undefined): boolean {
  return needsHostAccess(tracker) && origins(tracker).every((o) => granted?.includes(o));
}

/** The message shown when the user refuses the grant. */
export const accessRefusedNote = (tracker: Tracker): string =>
  `${TRACKER_INFO[tracker].label} needs access to ${TRACKER_INFO[tracker].hostAccess?.site} to connect.`;
