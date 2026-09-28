/**
 * List sync, background side: apply (plans/list-sync.md, phase 2). Writes the
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
 * even for the chunk that was in flight when the worker stopped (edge case 34).
 * For the same reason a preview can be applied once, and only while it is fresh
 * (edge case 36).
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
import { withPicks } from "./plan";
import { STALE_MS, type SyncPreview, jobAlive, readJob } from "./run";
import type { ChunkOutcome, SyncWrite } from "./types";

/** How old a preview may be when it is applied. An older one is planned from lists
 * that may have changed, so the user previews again (edge case 36). */
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
 * Each tracker's writes, from the preview's plan with the user's rating picks,
 * minus the items the user keeps out. In plan order, so one item's writes to a
 * tracker stay together. Pure.
 */
export function applyQueues(
  preview: SyncPreview,
  ignore: string[],
  picks: Record<string, number>,
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

/** Start applying the last preview, unless something blocks it. Returns at once;
 * the job reports through `listSyncApply`. */
export async function startApply(): Promise<{ started: boolean; reason?: ApplyBlock }> {
  const now = Date.now();
  const job = readJob(await listSyncJob.getValue());
  if (jobAlive(job, now)) return { started: false, reason: "previewing" };
  const [last, settings, picks] = await Promise.all([
    listSyncApply.getValue().then(readApply),
    listSyncSettings.getValue(),
    listSyncPicks.getValue(),
  ]);
  const preview = job?.preview;
  const queues = preview ? applyQueues(preview, settings.ignore, picks) : new Map();
  const reason = applyBlock(preview, last, queues, now);
  if (reason || !preview) return { started: false, reason: reason ?? "no_plan" };

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
  const start: ApplyJob = {
    v: APPLY_JOB_VERSION,
    state: "running",
    startedAt: now,
    beatAt: now,
    planAt: preview.at,
    trackers,
  };
  await listSyncApply.setValue(start);
  void runApply(start, queues);
  return { started: true };
}

/** Ask a running apply to stop after the chunk in flight. What was written stays:
 * every write is safe on its own. */
export async function cancelApply(): Promise<void> {
  await listSyncCancelAt.setValue(Date.now());
}

async function runApply(start: ApplyJob, queues: Map<Tracker, QueuedWrite[]>): Promise<void> {
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
          const out: ChunkOutcome = await applier.run(chunk.map((q) => q.w)).catch((e) => ({
            results: chunk.map(() => ({ ok: false, error: errorMessage(e) })),
            stop: errorMessage(e),
          }));
          const t = get(tracker);
          const tally = { done: t.done, changed: t.changed, failedCount: t.failedCount };
          const failed = [...t.failed];
          out.results.forEach((r, n) => {
            if (r.ok && r.reason === "changed") tally.changed += 1;
            else if (r.ok) tally.done += 1;
            else {
              tally.failedCount += 1;
              if (failed.length < MAX_FAILED)
                failed.push({ title: chunk[n]?.title ?? "", error: r.error ?? "Failed." });
            }
          });
          await setTracker(tracker, { ...tally, failed });
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
}
