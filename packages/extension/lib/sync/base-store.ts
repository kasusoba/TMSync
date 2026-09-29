/**
 * Saving the list sync base (`base.ts`). A preview keeps the lists it read as a
 * PENDING base. They become the base when nothing was left to write, or when the
 * apply of that preview took every write (then with the writes laid over). A run
 * that failed a write, or held a removal back for the user, leaves the old base.
 */
import { listSyncBase, listSyncBaseNext } from "../storage";
import type { Tracker } from "../trackers/types";
import { BASE_VERSION, type BaseEntry, type SyncBase, afterWrites } from "./base";
import type { SyncWrite } from "./types";

/** The base, when it was taken under these settings. */
export async function loadBase(sig: string): Promise<SyncBase["trackers"] | undefined> {
  const base = await listSyncBase.getValue().catch(() => null);
  return base && base.v === BASE_VERSION && base.sig === sig ? base.trackers : undefined;
}

/** Keep a preview's lists until its apply says whether they became the base. */
export async function savePending(
  planAt: number,
  sig: string,
  trackers: Partial<Record<Tracker, BaseEntry[]>>,
): Promise<void> {
  await listSyncBaseNext.setValue({ v: BASE_VERSION, planAt, sig, trackers }).catch(() => {});
}

/** Make the pending lists of preview `planAt` the base, with `writes` laid over.
 * A tracker that was not read keeps its old base. */
export async function commitBase(planAt: number, writes: SyncWrite[]): Promise<void> {
  const next = await listSyncBaseNext.getValue();
  if (!next || next.v !== BASE_VERSION || next.planAt !== planAt) return;
  const old = await listSyncBase.getValue().catch(() => null);
  const keep = old && old.v === BASE_VERSION && old.sig === next.sig ? old.trackers : {};
  await listSyncBase
    .setValue({
      v: BASE_VERSION,
      at: Date.now(),
      sig: next.sig,
      trackers: { ...keep, ...afterWrites(next.trackers, writes) },
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
