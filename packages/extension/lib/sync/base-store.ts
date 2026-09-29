/**
 * Saving the list sync base (`base.ts`). A preview keeps the lists it read as a
 * PENDING base. They become the base when nothing was left to write, or when the
 * apply of that preview took every write (then with the writes laid over). A run
 * that failed a write, or held a removal back for the user, leaves the old base.
 */
import { listSyncAccountAt, listSyncBase, listSyncBaseNext, listSyncCache } from "../storage";
import type { Tracker } from "../trackers/types";
import { BASE_VERSION, type BaseEntry, type SyncBase, afterWrites } from "./base";
import type { SyncWrite } from "./types";

/** The base, when it was taken under these settings. */
export async function loadBase(sig: string): Promise<SyncBase["trackers"] | undefined> {
  const base = await listSyncBase.getValue().catch(() => null);
  return base && base.v === BASE_VERSION && base.sig === sig ? base.trackers : undefined;
}

/** Keep a preview's lists until its apply says whether they became the base.
 * `readAt` = when its reads started. */
export async function savePending(
  planAt: number,
  readAt: number,
  sig: string,
  trackers: Partial<Record<Tracker, BaseEntry[]>>,
): Promise<void> {
  await listSyncBaseNext
    .setValue({ v: BASE_VERSION, planAt, readAt, sig, trackers })
    .catch(() => {});
}

/** The trackers whose account was connected or disconnected at or after `since`:
 * what was read from them before then belongs to the old account. */
export async function accountsChangedSince(since: number): Promise<Tracker[]> {
  const at = await listSyncAccountAt.getValue().catch(() => ({}));
  return (Object.entries(at) as [Tracker, number][])
    .filter(([, t]) => t >= since)
    .map(([tk]) => tk);
}

/** Make the pending lists of preview `planAt` the base, with `writes` laid over.
 * A tracker that was not read keeps its old base. */
export async function commitBase(planAt: number, writes: SyncWrite[]): Promise<void> {
  const next = await listSyncBaseNext.getValue();
  if (!next || next.v !== BASE_VERSION || next.planAt !== planAt) return;
  const old = await listSyncBase.getValue().catch(() => null);
  const keep = old && old.v === BASE_VERSION && old.sig === next.sig ? old.trackers : {};
  // A list read from an account that changed since is not this account's list.
  // A preview that ran across the change saved it after `forgetBase` dropped it.
  const changed = await accountsChangedSince(next.readAt);
  const lists = afterWrites(next.trackers, writes);
  for (const tk of changed) delete lists[tk];
  await listSyncBase
    .setValue({
      v: BASE_VERSION,
      at: Date.now(),
      sig: next.sig,
      trackers: { ...keep, ...lists },
    })
    .catch(() => listSyncBase.removeValue());
  await listSyncBaseNext.removeValue().catch(() => {});
}

/** Forget one tracker's base, and its lists in the pending one (its account was
 * connected or disconnected: they belong to the old account). */
export async function forgetBase(tracker: Tracker): Promise<void> {
  const [base, next] = await Promise.all([
    listSyncBase.getValue().catch(() => null),
    listSyncBaseNext.getValue().catch(() => null),
  ]);
  if (base?.trackers[tracker]) {
    const { [tracker]: _gone, ...rest } = base.trackers;
    await listSyncBase.setValue({ ...base, trackers: rest });
  }
  if (next?.trackers[tracker]) {
    const { [tracker]: _gone, ...rest } = next.trackers;
    await listSyncBaseNext.setValue({ ...next, trackers: rest });
  }
}

/** Forget what list sync saved for one tracker's account: its read cache and its
 * base, and stamp the change (`listSyncAccountAt`). Never throws, so a storage error cannot keep an account from connecting
 * or disconnecting. */
export async function forgetLists(tracker: Tracker): Promise<void> {
  // First: a preview or apply that is running checks this stamp.
  await listSyncAccountAt
    .getValue()
    .then((at) => listSyncAccountAt.setValue({ ...at, [tracker]: Date.now() }))
    .catch(() => {});
  await listSyncCache(tracker)
    .removeValue()
    .catch(() => {});
  await forgetBase(tracker).catch(() => {});
}
