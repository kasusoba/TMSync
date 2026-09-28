import { ALL_TRACKERS, type Tracker } from "@/lib/trackers/types";
import { type AccountStatus, sendMessage } from "@/messaging";

/** Each tracker's account status, keyed by tracker (the popup and options page). */
export type Accounts = Partial<Record<Tracker, AccountStatus>>;

/** Read every tracker's account status from the background. */
export async function loadAccounts(): Promise<Accounts> {
  const all = await Promise.all(ALL_TRACKERS.map((tk) => sendMessage("getTrackerStatus", tk)));
  return Object.fromEntries(ALL_TRACKERS.map((tk, i) => [tk, all[i]]));
}
