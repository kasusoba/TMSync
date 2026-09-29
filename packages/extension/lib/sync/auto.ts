/**
 * List sync, the automatic run (docs/ARCHITECTURE.md section 7, "Automatic sync").
 * Optional and off by default (`ListSyncSettings.auto`). Once a day an alarm runs the same
 * preview and apply jobs the user runs by hand, but applies only the ADDITIONS:
 * what cannot lose anything. Everything else (removals, status changes, conflicts)
 * waits for the user, and the toolbar badge counts it.
 *
 * Nothing lives in memory (constraint #4): the alarm wakes the worker, the jobs
 * save their steps to storage, and the result is saved as `listSyncAuto`.
 */
import { browser } from "wxt/browser";
import { errorMessage } from "../errors";
import {
  listSyncApply,
  listSyncAuto,
  listSyncAutoSeen,
  listSyncJob,
  listSyncSettings,
} from "../storage";
import { trackerLabel } from "../trackers/types";
import { APPLY_FRESH_MS, type ApplyJob, applyQueues, beginApply, readApply } from "./apply";
import { commitBase } from "./base-store";
import { type SyncJob, beginPreview, jobAlive, readJob } from "./run";
import type { SyncItem, SyncPlan, SyncWrite } from "./types";

export const AUTO_ALARM = "tmsync-list-sync";

const DAY_MIN = 24 * 60;

/** A run closer than this to the last one is skipped. Alarms can fire again on a
 * browser start (Firefox forgets them, Chrome catches up once), and that must
 * not make it more than daily. */
export const AUTO_GAP_MS = 20 * 60 * 60_000;

/** The last automatic run, as saved. */
export interface AutoRun {
  at: number;
  state: "done" | "failed" | "skipped";
  /** Writes applied, over every tracker. */
  added: number;
  /** Writes that failed. */
  failed: number;
  /** The items (`SyncItem.key`) with changes that wait for the user. */
  held: string[];
  /** Trackers left out or stopped early, and why. */
  notes: string[];
  error?: string;
}

/**
 * The part of a plan an automatic run applies on its own, and the items it holds
 * back for the user. Pure.
 *
 * In: watched episodes and movies, rating fills (never a picked score), new list
 * entries, progress up, a higher rewatch count, and the status that progress
 * brings with it (watching, or completed at the last episode).
 * Held: removals (of entries and ratings), a status change with no progress, a
 * new entry whose status the trackers disagree on, and every conflict.
 */
export function additionsOnly(plan: SyncPlan): { plan: SyncPlan; held: string[] } {
  const held = new Set(plan.conflicts.map((c) => c.key));
  const contested = new Set(plan.conflicts.filter((c) => c.field === "status").map((c) => c.key));
  const items: SyncItem[] = [];
  for (const item of plan.items) {
    const writes: SyncWrite[] = [];
    for (const w of item.writes) {
      const kept = addition(w, contested.has(item.key));
      if (kept !== w) held.add(item.key);
      if (kept) writes.push(kept);
    }
    if (writes.length) items.push({ ...item, writes });
  }
  return { plan: { ...plan, items }, held: [...held] };
}

/** The write, the part of it that only adds, or null. Pure. */
function addition(w: SyncWrite, contested: boolean): SyncWrite | null {
  switch (w.op) {
    case "episodes":
    case "movie":
      return w;
    case "rating":
      return w.picked ? null : w;
    case "remove":
    case "unrate":
      return null;
    case "entry": {
      if (w.create) return contested ? null : w;
      const up = !!w.progress && w.progress.to > w.progress.from;
      const follows = up && (w.status?.to === "CURRENT" || w.status?.to === "COMPLETED");
      if (!w.status || follows) return w;
      const { status: _held, ...rest } = w;
      return rest.progress || rest.repeat ? rest : null;
    }
  }
}

/** Whether a held item removes something (an entry or a rating). Pure. */
export function holdsRemoval(plan: SyncPlan, held: string[], ignore: string[] = []): boolean {
  const h = new Set(held);
  const out = new Set(ignore);
  return plan.items.some(
    (i) =>
      h.has(i.key) &&
      !out.has(i.key) &&
      i.writes.some((w) => w.op === "remove" || w.op === "unrate"),
  );
}

/** How many held items the user has not seen yet (the badge count). Pure. */
export function unseen(run: AutoRun | null, seen: string[]): number {
  if (!run) return 0;
  const saw = new Set(seen);
  return run.held.filter((k) => !saw.has(k)).length;
}

/**
 * Whether the user has a preview open that they may still apply: made by hand, with
 * writes, fresh, and not applied yet. The automatic run would replace it (and the
 * user's picks with it), so it waits for the next day instead. Pure.
 */
export function previewWaiting(job: SyncJob | null, last: ApplyJob | null, now: number): boolean {
  const p = job?.preview;
  if (!p || p.auto || p.reason || !p.plan.items.length) return false;
  return now - p.at <= APPLY_FRESH_MS && last?.planAt !== p.at;
}

/** Make the alarm match the setting: there while auto sync is on, gone when off.
 * A new alarm fires a minute later, so turning it on syncs soon. */
export async function syncAutoAlarm(): Promise<void> {
  const { auto } = await listSyncSettings.getValue();
  const alarm = await browser.alarms.get(AUTO_ALARM);
  if (!auto) {
    if (alarm) await browser.alarms.clear(AUTO_ALARM);
    return;
  }
  if (!alarm) browser.alarms.create(AUTO_ALARM, { delayInMinutes: 1, periodInMinutes: DAY_MIN });
}

/** Show the count of held items the user has not seen on the toolbar icon (empty
 * when none, or when auto sync is off). The global text: a tab never sets its own
 * (see the background's `setActionBadge`). */
export async function showAutoBadge(): Promise<void> {
  const [{ auto }, run, seen] = await Promise.all([
    listSyncSettings.getValue(),
    listSyncAuto.getValue(),
    listSyncAutoSeen.getValue(),
  ]);
  const n = auto ? unseen(run, seen) : 0;
  const action = browser.action ?? browser.browserAction;
  await action.setBadgeText({ text: n ? String(Math.min(n, 999)) : "" });
  if (n) await action.setBadgeBackgroundColor({ color: "#ed1c24" });
}

/**
 * One automatic run: read and plan (the preview job), then apply the additions
 * (the apply job). Skipped when auto sync is off, when it ran less than a day
 * ago, while the user's own sync runs, or while a preview they made waits to be
 * applied.
 */
export async function runAuto(): Promise<void> {
  const settings = await listSyncSettings.getValue();
  if (!settings.auto) return;
  const last = await listSyncAuto.getValue();
  if (last && last.state !== "skipped" && Date.now() - last.at < AUTO_GAP_MS) return;
  const save = (run: Omit<AutoRun, "at">) => listSyncAuto.setValue({ at: Date.now(), ...run });
  const blank = { added: 0, failed: 0, held: last?.held ?? [], notes: [] as string[] };

  const now = Date.now();
  const [job, apply] = [
    readJob(await listSyncJob.getValue()),
    readApply(await listSyncApply.getValue()),
  ];
  if (previewWaiting(job, apply, now))
    return save({ ...blank, state: "skipped", notes: ["A preview was waiting."] });
  const busy = jobAlive(job, now) || jobAlive(apply, now);
  const running = busy ? null : await beginPreview(true);
  if (!running) return save({ ...blank, state: "skipped", notes: ["A sync was running."] });

  try {
    const job = await running;
    const preview = job.preview;
    const notes = job.reads.flatMap((r) =>
      r.state === "failed" || r.state === "not_connected"
        ? [`${trackerLabel(r.tracker)}: ${r.error ?? "not connected"}`]
        : [],
    );
    if (!preview) return save({ ...blank, notes, state: "failed", error: job.error });
    if (preview.reason === "too_few")
      return save({ ...blank, notes, state: "skipped", error: "Fewer than two lists were read." });

    const { plan, held } = additionsOnly(preview.plan);
    const queues = applyQueues({ ...preview, plan }, settings.ignore, {});
    // A removal held for the user must stay "removed since the base", so the base
    // moves only when none is held (`base-store.ts`).
    const full = !holdsRemoval(preview.plan, held, settings.ignore);
    if (![...queues.values()].some((q) => q.length)) {
      if (full) await commitBase(preview.at, []).catch(() => {});
      return save({ ...blank, notes, held, state: "done" });
    }

    const applied = await beginApply(preview, queues, true, full);
    if (!applied)
      return save({ ...blank, notes, held, state: "skipped", error: "A sync was running." });
    for (const t of applied.trackers)
      if (t.error) notes.push(`${trackerLabel(t.tracker)}: ${t.error}`);
    return save({
      state: applied.state === "failed" ? "failed" : "done",
      added: applied.trackers.reduce((n, t) => n + t.done, 0),
      failed: applied.trackers.reduce((n, t) => n + t.failedCount, 0),
      held,
      notes,
      error: applied.error,
    });
  } catch (e) {
    return save({ ...blank, state: "failed", error: errorMessage(e) });
  }
}
