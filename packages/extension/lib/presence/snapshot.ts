import { presenceSnapshots } from "@/lib/storage";
import { browser } from "wxt/browser";
import type { PresenceState } from "./types";

/**
 * A "playing" snapshot is refreshed every few seconds by the content script; one
 * older than this means the tab died without a clean clear, so we drop it rather
 * than show a stale "watching".
 */
const STALE_MS = 30_000;

/** Store the focused presence for a tab (background side — tabId from the sender). */
export async function putPresence(tabId: number, state: PresenceState): Promise<void> {
  const all = await presenceSnapshots.getValue();
  all[tabId] = { ...state, updatedAt: Date.now() };
  await presenceSnapshots.setValue(all);
}

/** Drop a tab's presence (clean stop, nav-away, or tab removed). */
export async function clearPresence(tabId: number): Promise<void> {
  const all = await presenceSnapshots.getValue();
  if (all[tabId]) {
    delete all[tabId];
    await presenceSnapshots.setValue(all);
  }
}

/**
 * The presence for the currently focused tab — the relay's `active` mode shows
 * only the focused tab, so that's the one the poll answers with. Stale playing
 * snapshots (a dead tab) are ignored. Returns null when nothing applies.
 */
export async function focusedPresence(): Promise<PresenceState | null> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return null;
  const snap = (await presenceSnapshots.getValue())[tab.id];
  if (!snap) return null;
  if (!snap.paused && Date.now() - snap.updatedAt > STALE_MS) return null;
  const { updatedAt: _updatedAt, ...state } = snap;
  return state;
}
