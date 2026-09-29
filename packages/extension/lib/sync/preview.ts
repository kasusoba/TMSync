/**
 * List sync, background side (docs/ARCHITECTURE.md section 7): the preview. It reads and
 * plans only; nothing here writes to a tracker (`apply.ts` does, from the plan
 * saved here).
 *
 * A preview runs as a JOB whose state lives in storage (`listSyncJob`), not as one
 * long message. Reading four lists can take longer than the browser lets a worker
 * sit on one request, and a worker stopped mid-request gives the page no answer at
 * all. So the start message returns at once, the job saves each step, and the
 * options page watches the storage item. If the worker is stopped anyway, the
 * last saved step says where (nothing a later run needs lives only in memory; the scoped exception to constraint #4 is in `job.ts`).
 */
import { errorMessage } from "../errors";
import {
  animapOverrides,
  animeMap,
  listSyncApply,
  listSyncCache,
  listSyncJob,
  listSyncPicks,
  listSyncSettings,
} from "../storage";
import { Animap } from "../trackers/animap/index";
import { withOverrides } from "../trackers/animap/overrides";
import { getAdapter } from "../trackers/index";
import { getService } from "../trackers/service";
import { ALL_TRACKERS, type Tracker } from "../trackers/types";
import { nextLists, settingsSig } from "./base";
import { accountsChangedSince, commitBase, loadBase, savePending } from "./base-store";
import { exclusive, jobAlive, jobRunner, versioned } from "./job";
import { planSync, summarize, syncKindsFor, takesKind } from "./plan/index";
import type { ScoreScale } from "./score";
import { type ListEntry, type SyncPlan, type SyncTotals, pickKey } from "./types";

/** One tracker's part in a preview. */
export interface TrackerRead {
  tracker: Tracker;
  /** `reading` while its list loads; `read` = its list is in the plan. The rest
   * say why it is not. */
  state: "waiting" | "reading" | "read" | "not_connected" | "off" | "failed";
  /** How many entries its list has. */
  count?: number;
  /** How much was read (see `ListRead.from`): `saved` = nothing changed since the
   * last read, `changes` = only what changed. Missing = a full read. */
  from?: "saved" | "changes";
  error?: string;
}

export interface SyncPreview {
  /** When the lists were read (ms). */
  at: number;
  /** When the reads started (ms). An account connected or disconnected since then
   * makes this plan stale (`accountsChangedSince`). */
  readAt: number;
  reads: TrackerRead[];
  /** Why there is no plan (fewer than two lists read). */
  reason?: "too_few";
  /** The crosswalk is not downloaded yet, so anime cannot cross between Trakt and
   * the cour trackers. */
  noCrosswalk?: boolean;
  totals: SyncTotals[];
  plan: SyncPlan;
  /** Each tracker's score scale, to turn a picked score into its writes. */
  scales: Partial<Record<Tracker, ScoreScale>>;
  /** The automatic daily run made it (`auto.ts`), and applied its additions. */
  auto?: boolean;
}

/**
 * The shape version of a saved job. Bump it whenever `SyncJob`, `SyncPreview`, or
 * `SyncPlan` changes shape: a job saved by an older build is then dropped on read,
 * instead of rendering (and crashing on) fields it does not have.
 */
export const SYNC_JOB_VERSION = 9;

/** A preview job, as saved in storage. */
export interface SyncJob {
  v: number;
  state: "running" | "done" | "failed";
  startedAt: number;
  /** Last sign of life (ms). A running job with an old beat was stopped. */
  beatAt: number;
  /** What it is doing now, per tracker. */
  reads: TrackerRead[];
  /** Planning, once the lists are in. */
  planning?: boolean;
  preview?: SyncPreview;
  error?: string;
  /** The automatic daily run started it (the options page says so while it runs). */
  auto?: boolean;
}

/** A saved job, or null when it is missing or from an older build. Pure. */
export const readJob = versioned<SyncJob>(SYNC_JOB_VERSION);

/**
 * Start a preview unless one is running. Returns at once; the job reports through
 * `listSyncJob`. Writes nothing to a tracker.
 */
export async function startPreview(): Promise<{ started: boolean }> {
  return { started: (await beginPreview(false)) !== null };
}

/**
 * Start a preview job unless a preview or an apply is running. Resolves to the
 * running job (which ends with the preview, or a failure), or null when it could
 * not start. `auto` = the automatic run started it: it is on a timer, which some
 * trackers treat differently (Simkl never reads in full on a timer).
 */
export async function beginPreview(auto: boolean): Promise<Promise<SyncJob> | null> {
  const start = await exclusive(async () => {
    if (jobAlive(readJob(await listSyncJob.getValue()), Date.now())) return null;
    // A preview during an apply would plan from lists that are half written.
    if (jobAlive(await listSyncApply.getValue(), Date.now())) return null;
    const now = Date.now();
    const job: SyncJob = {
      v: SYNC_JOB_VERSION,
      state: "running",
      startedAt: now,
      beatAt: now,
      reads: [],
      ...(auto ? { auto } : {}),
    };
    await listSyncJob.setValue(job);
    return job;
  });
  return start ? runPreview(start, auto) : null;
}

async function runPreview(start: SyncJob, auto: boolean): Promise<SyncJob> {
  const run = jobRunner(listSyncJob, start);
  const { save } = run;
  const setRead = (r: TrackerRead) =>
    save({
      reads: [...run.get().reads.filter((x) => x.tracker !== r.tracker), r].sort(byTracker),
    });

  try {
    const settings = await listSyncSettings.getValue();
    const entries: ListEntry[] = [];
    const scales: Partial<Record<Tracker, ScoreScale>> = {};
    const withList = ALL_TRACKERS.filter((tk) => getService(tk).readList);
    await save({ reads: withList.map((tracker) => ({ tracker, state: "waiting" })) });

    await Promise.all(
      withList.map(async (tracker) => {
        const kinds = syncKindsFor(tracker).filter((k) => takesKind(tracker, k, settings));
        if (!kinds.length) return setRead({ tracker, state: "off" });
        const connected = await getAdapter(tracker)
          .isConnected()
          .catch(() => false);
        if (!connected) return setRead({ tracker, state: "not_connected" });
        await setRead({ tracker, state: "reading" });
        try {
          const cache = listSyncCache(tracker);
          const saved = await cache.getValue().catch(() => null);
          const list = await (
            getService(tracker).readList as NonNullable<ReturnType<typeof getService>["readList"]>
          )(kinds, saved, auto);
          // The account changed during the read: the list is the old account's.
          if ((await accountsChangedSince(start.startedAt)).includes(tracker))
            throw new Error("The account changed during the read. Preview again.");
          // Not `push(...)`: a spread of a very long list throws a RangeError.
          for (const e of list.entries) entries.push(e);
          if (list.scoreFormat) scales[tracker] = list.scoreFormat;
          // A list too big to save is read in full next time; drop the old one.
          if (list.cache) await cache.setValue(list.cache).catch(() => cache.removeValue());
          await setRead({ tracker, state: "read", count: list.entries.length, from: list.from });
        } catch (e) {
          await setRead({ tracker, state: "failed", error: errorMessage(e) });
        }
      }),
    );

    await save({ planning: true });
    const reads = run.get().reads;
    const trackers = reads.filter((r) => r.state === "read").map((r) => r.tracker);
    // The crosswalk with the user's fix-match pins over it, as scrobbling uses it.
    const [cached, overrides] = await Promise.all([
      animeMap.getValue(),
      animapOverrides.getValue(),
    ]);
    const animap = new Animap(withOverrides(cached?.rows ?? [], overrides));
    const head = {
      at: Date.now(),
      readAt: start.startedAt,
      reads,
      noCrosswalk: !cached?.rows.length,
      scales,
      ...(auto ? { auto } : {}),
    };
    const empty: SyncPlan = { items: [], skips: [], conflicts: [], notices: [] };
    // Plan against the base, so a removal on one list is not added back from another.
    const sig = settingsSig(settings);
    const last = await loadBase(sig);
    const preview: SyncPreview =
      trackers.length < 2
        ? { ...head, reason: "too_few", totals: [], plan: empty }
        : (() => {
            const plan = planSync({ entries, trackers, settings, animap, scales, base: last });
            return { ...head, totals: summarize(plan, trackers), plan };
          })();
    // The lists as read, with the plan's removed marks, become the base once this
    // plan is fully applied, or now when there is nothing to write.
    if (!preview.reason) {
      await savePending(
        preview.at,
        preview.readAt,
        sig,
        nextLists(entries, trackers, preview.plan.removed),
      );
      if (!preview.plan.items.length) await commitBase(preview.at, []);
      // Picks for disagreements this plan no longer has are done with.
      const open = new Set(preview.plan.conflicts.map(pickKey));
      const picks = await listSyncPicks.getValue().catch(() => ({}));
      const kept = Object.fromEntries(Object.entries(picks).filter(([k]) => open.has(k)));
      if (Object.keys(kept).length !== Object.keys(picks).length)
        await listSyncPicks.setValue(kept).catch(() => {});
    }
    await save({ state: "done", planning: false, preview });
  } catch (e) {
    await save({ state: "failed", planning: false, error: errorMessage(e) });
  } finally {
    await run.stop();
  }
  // A plan too big for local storage fails to save; say so instead of hanging.
  const saved = await listSyncJob.getValue();
  if (saved?.state !== "running") return run.get();
  const failed: SyncJob = {
    ...run.get(),
    state: "failed",
    preview: undefined,
    error: "The plan was too large to save.",
  };
  await listSyncJob.setValue(failed).catch(() => {});
  return failed;
}

function byTracker(a: TrackerRead, b: TrackerRead): number {
  return ALL_TRACKERS.indexOf(a.tracker) - ALL_TRACKERS.indexOf(b.tracker);
}
