/**
 * List sync, background side: apply (docs/ARCHITECTURE.md section 7). Writes the
 * plan of the last preview to each tracker.
 *
 * Like the preview, an apply is a JOB whose state lives in storage
 * (`listSyncApply`): the start message returns at once, and each tracker's
 * writes go out in chunks (the tracker picks the size), with the position saved
 * after each one. Trackers run side by side; each spaces its own requests.
 *
 * There is no resume from a saved position. To finish a stopped or cancelled
 * apply, the user previews again and applies that plan. The planner diffs
 * against what each tracker has NOW, so whatever was written drops out of the
 * new plan, and a history write (a new play on Trakt) is never sent twice,
 * even for the chunk that was in flight when the worker stopped.
 * For the same reason a preview can be applied once, and only while it is fresh
 * (a plan from lists that changed since could undo a newer watch).
 */
import { browser } from "wxt/browser";
import { errorMessage } from "../errors";
import {
  listSyncApply,
  listSyncCancelAt,
  listSyncJob,
  listSyncPicks,
  listSyncSettings,
} from "../storage";
import { getService } from "../trackers/service";
import { ALL_TRACKERS, type Tracker } from "../trackers/types";
import { commitBase } from "./base-store";
import { exclusive } from "./lock";
import { withPicks } from "./plan";
import { STALE_MS, type SyncPreview, jobAlive, readJob } from "./run";
import type { ChunkOutcome, SyncPicks, SyncWrite, WriteOutcome } from "./types";

/** How old a preview may be when it is applied. An older one is planned from lists
 * that may have changed, so the user previews again. */
export const APPLY_FRESH_MS = 10 * 60_000;

/** The shape version of a saved apply job (see `SYNC_JOB_VERSION`). */
export const APPLY_JOB_VERSION = 1;

/** Failed writes kept per tracker, for the summary. */
const MAX_FAILED = 200;

const BEAT_MS = STALE_MS / 3;

/** One tracker's part in an apply. */
export interface ApplyTracker {
  tracker: Tracker;
  /** `stopped` = it had to stop early (a limit, or it was disconnected): `error`
   * says why. `cancelled` = the user stopped the apply. */
  state: "waiting" | "running" | "done" | "stopped" | "cancelled";
  total: number;
  /** Writes sent and taken. */
  done: number;
  /** Writes left out because the entry changed since the preview. */
  changed: number;
  /** How many writes failed, and the first few with why. */
  failedCount: number;
  failed: { title: string; error: string }[];
  error?: string;
}

export interface ApplyJob {
  v: number;
  state: "running" | "done" | "cancelled" | "failed";
  startedAt: number;
  beatAt: number;
  /** The preview this applied (its `at`): a preview is applied once. */
  planAt: number;
  /** The automatic daily run applied it (its additions only). */
  auto?: boolean;
  trackers: ApplyTracker[];
  error?: string;
}

/** Why an apply cannot start. */
export type ApplyBlock =
  /** An apply is running. */
  | "running"
  /** A preview is running. */
  | "previewing"
  /** No preview with a plan. */
  | "no_plan"
  /** This preview was applied already: preview again. */
  | "spent"
  /** The preview is too old: preview again. */
  | "stale"
  /** The plan writes nothing. */
  | "nothing";

/** A saved apply job, or null when missing or from an older build. Pure. */
export function readApply(raw: unknown): ApplyJob | null {
  const job = raw as ApplyJob | null;
  return job && job.v === APPLY_JOB_VERSION ? job : null;
}

/** One write, with the item it belongs to (for the summary). */
export interface QueuedWrite {
  w: SyncWrite;
  title: string;
}

/**
 * Each tracker's writes, from the preview's plan with the user's picks,
 * minus the items the user keeps out. In plan order, so one item's writes to a
 * tracker stay together. Pure.
 */
export function applyQueues(
  preview: SyncPreview,
  ignore: string[],
  picks: SyncPicks,
): Map<Tracker, QueuedWrite[]> {
  const kept = new Set(ignore);
  const plan = withPicks(preview.plan, picks, preview.scales);
  const out = new Map<Tracker, QueuedWrite[]>();
  for (const item of plan.items) {
    if (kept.has(item.key)) continue;
    for (const w of item.writes) {
      const q = out.get(w.tracker) ?? [];
      q.push({ w, title: item.title });
      out.set(w.tracker, q);
    }
  }
  return out;
}

/** Why this preview cannot be applied now, or null when it can. Pure (the options
 * page shows the same answer the background gives). */
export function applyBlock(
  preview: SyncPreview | null | undefined,
  last: ApplyJob | null,
  queues: Map<Tracker, QueuedWrite[]>,
  now: number,
): ApplyBlock | null {
  if (jobAlive(last, now)) return "running";
  if (!preview || preview.reason) return "no_plan";
  if (last && last.planAt === preview.at) return "spent";
  if (now - preview.at > APPLY_FRESH_MS) return "stale";
  if (![...queues.values()].some((q) => q.length)) return "nothing";
  return null;
}

/** Start applying the last preview, unless something blocks it. Returns once the
 * job is saved; the job reports through `listSyncApply`. A failed first save
 * rejects, so the page shows it. */
export async function startApply(): Promise<{ started: boolean; reason?: ApplyBlock }> {
  return exclusive(async () => {
    const now = Date.now();
    const job = readJob(await listSyncJob.getValue());
    if (jobAlive(job, now)) return { started: false, reason: "previewing" as const };
    const [last, settings, picks] = await Promise.all([
      listSyncApply.getValue().then(readApply),
      listSyncSettings.getValue(),
      listSyncPicks.getValue(),
    ]);
    const preview = job?.preview;
    const queues = preview ? applyQueues(preview, settings.ignore, picks) : new Map();
    const reason = applyBlock(preview, last, queues, now);
    if (reason || !preview) return { started: false, reason: reason ?? "no_plan" };
    const start = newApply(preview, queues, false);
    await listSyncApply.setValue(start);
    // The run saves its own failure; this catch only keeps a rejection from going
    // unhandled.
    void finishApply(start, preview, queues, true).catch(() => {});
    return { started: true };
  });
}

/** Every write went in as planned: none failed, none was left out because the
 * entry changed, and no tracker stopped early. Pure. */
export function cleanApply(job: ApplyJob): boolean {
  return (
    job.state === "done" &&
    job.trackers.every((t) => t.state === "done" && !t.failedCount && !t.changed)
  );
}

/**
 * Save a new apply job for `preview` and run it, unless a preview or an apply
 * runs. Resolves to the finished job, or null when it could not start. The caller
 * checks the rest first (`applyBlock`). `full` = the queues hold every removal
 * the plan has (the automatic run may hold some back): a clean apply of them
 * makes the lists the new base (`base-store.ts`).
 */
export async function beginApply(
  preview: SyncPreview,
  queues: Map<Tracker, QueuedWrite[]>,
  auto: boolean,
  full: boolean,
): Promise<ApplyJob | null> {
  const start = await exclusive(async () => {
    const now = Date.now();
    if (jobAlive(readJob(await listSyncJob.getValue()), now)) return null;
    if (jobAlive(readApply(await listSyncApply.getValue()), now)) return null;
    const job = newApply(preview, queues, auto);
    await listSyncApply.setValue(job);
    return job;
  });
  return start && finishApply(start, preview, queues, full);
}

/** A new, running apply job for `preview`. Pure. */
function newApply(
  preview: SyncPreview,
  queues: Map<Tracker, QueuedWrite[]>,
  auto: boolean,
): ApplyJob {
  const now = Date.now();
  const trackers: ApplyTracker[] = ALL_TRACKERS.filter((tk) => queues.get(tk)?.length).map(
    (tracker) => ({
      tracker,
      state: "waiting",
      total: queues.get(tracker)?.length ?? 0,
      done: 0,
      changed: 0,
      failedCount: 0,
      failed: [],
    }),
  );
  return {
    v: APPLY_JOB_VERSION,
    state: "running",
    startedAt: now,
    beatAt: now,
    planAt: preview.at,
    trackers,
    ...(auto ? { auto } : {}),
  };
}

/** Run a saved apply job, then move the base if it was clean and `full`. */
async function finishApply(
  start: ApplyJob,
  preview: SyncPreview,
  queues: Map<Tracker, QueuedWrite[]>,
  full: boolean,
): Promise<ApplyJob> {
  const done = await runApply(start, queues);
  if (full && cleanApply(done)) {
    const writes = [...queues.values()].flatMap((q) => q.map((x) => x.w));
    await commitBase(preview.at, writes).catch(() => {});
  }
  return done;
}

/** Ask a running apply to stop after the chunk in flight. What was written stays:
 * every write is safe on its own. */
export async function cancelApply(): Promise<void> {
  await listSyncCancelAt.setValue(Date.now());
}

async function runApply(start: ApplyJob, queues: Map<Tracker, QueuedWrite[]>): Promise<ApplyJob> {
  let job = start;
  let saving: Promise<void> = Promise.resolve();
  const save = (patch: Partial<ApplyJob>) => {
    job = { ...job, ...patch, beatAt: Date.now() };
    const snapshot = job;
    saving = saving.then(() => listSyncApply.setValue(snapshot)).catch(() => {});
    return saving;
  };
  const setTracker = (tk: Tracker, patch: Partial<ApplyTracker>) =>
    save({
      trackers: job.trackers.map((t) => (t.tracker === tk ? { ...t, ...patch } : t)),
    });
  const get = (tk: Tracker) => job.trackers.find((t) => t.tracker === tk) as ApplyTracker;
  const cancelled = async () => (await listSyncCancelAt.getValue()) > start.startedAt;

  const beat = setInterval(() => {
    void save({});
    browser.runtime.getPlatformInfo().catch(() => {});
  }, BEAT_MS);

  try {
    await Promise.all(
      job.trackers.map(async ({ tracker }) => {
        const queue = queues.get(tracker) ?? [];
        const applier = getService(tracker).applyList;
        if (!applier) {
          return setTracker(tracker, { state: "stopped", error: "Sync can’t write to it yet." });
        }
        await setTracker(tracker, { state: "running" });
        for (let i = 0; i < queue.length; i += applier.chunk) {
          if (await cancelled()) return setTracker(tracker, { state: "cancelled" });
          const chunk = queue.slice(i, i + applier.chunk);
          // Count each write once: as the tracker reports it (one entry at a time,
          // so the counts move while a slow chunk runs), or at the chunk's end.
          const counted = new Set<number>();
          const count = (at: number[], results: (WriteOutcome | undefined)[]) => {
            const t = get(tracker);
            const tally = { done: t.done, changed: t.changed, failedCount: t.failedCount };
            const failed = [...t.failed];
            at.forEach((n, k) => {
              const r = results[k];
              if (!r || counted.has(n)) return;
              counted.add(n);
              if (r.ok && r.reason === "changed") tally.changed += 1;
              else if (r.ok) tally.done += 1;
              else {
                tally.failedCount += 1;
                if (failed.length < MAX_FAILED)
                  failed.push({ title: chunk[n]?.title ?? "", error: r.error ?? "Failed." });
              }
            });
            return setTracker(tracker, { ...tally, failed });
          };
          const out: ChunkOutcome = await applier
            .run(
              chunk.map((q) => q.w),
              (at, r) =>
                void count(
                  at,
                  at.map(() => r),
                ),
            )
            .catch((e) => ({
              results: chunk.map(() => ({ ok: false, error: errorMessage(e) })),
              stop: errorMessage(e),
            }));
          await count(
            out.results.map((_, n) => n),
            out.results,
          );
          if (out.stop) return setTracker(tracker, { state: "stopped", error: out.stop });
        }
        await setTracker(tracker, { state: "done" });
      }),
    );
    await save({ state: (await cancelled()) ? "cancelled" : "done" });
  } catch (e) {
    await save({ state: "failed", error: errorMessage(e) });
  } finally {
    clearInterval(beat);
    await saving;
  }
  return job;
}
