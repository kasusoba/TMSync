/** A running or finished apply, per tracker. */
import { type ApplyJob, type ApplyTracker, cleanApply } from "@/lib/sync/apply";
import { trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
import { useState } from "preact/hooks";
import { Btn, Icon, type Tokens, TrackerMark } from "../kit";

const APPLY_STATE: Record<ApplyTracker["state"], string> = {
  waiting: "Waiting",
  running: "Writing…",
  done: "Done",
  stopped: "Stopped",
  cancelled: "Stopped",
};

/** An apply: each tracker's progress while it runs, then what was written. */
export function ApplyProgress({
  t,
  job,
  running,
  onCancel,
}: { t: Tokens; job: ApplyJob; running: boolean; onCancel: () => void }) {
  const [open, setOpen] = useState(false);
  // "running" in storage with no recent beat: the browser stopped the worker.
  const dead = job.state === "running" && !running;
  const failed = job.trackers.flatMap((x) => x.failed.map((f) => ({ ...f, tracker: x.tracker })));
  const failedCount = job.trackers.reduce((n, x) => n + x.failedCount, 0);
  const clean = cleanApply(job);
  const title = running
    ? "Applying…"
    : dead
      ? "The apply stopped"
      : job.state === "cancelled"
        ? "You stopped the apply"
        : job.state === "failed"
          ? "The apply failed"
          : "Applied";
  return (
    <div class="space-y-3">
      <div class="flex items-center gap-3">
        <span class={clsx("flex-1 text-[13px] font-semibold", t.heading)}>{title}</span>
        {running && (
          <Btn t={t} tone="ghost" onClick={onCancel}>
            Stop
          </Btn>
        )}
      </div>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {job.trackers.map((x) => {
          const sent = x.done + x.changed + x.failedCount;
          return (
            <div key={x.tracker} class={clsx("space-y-2 rounded-lg p-3", t.card)}>
              <div class="flex items-center gap-2">
                <TrackerMark tracker={x.tracker} />
                <span class={clsx("flex-1 text-[13px] font-semibold", t.heading)}>
                  {trackerLabel(x.tracker)}
                </span>
                <span class={clsx("text-[11px]", t.faint)}>{APPLY_STATE[x.state]}</span>
              </div>
              <div class={clsx("h-1 overflow-hidden rounded-full", t.chip)}>
                <div
                  class={clsx("h-full", t.primary)}
                  style={{ width: `${x.total ? Math.round((sent / x.total) * 100) : 100}%` }}
                />
              </div>
              <p class={clsx("text-[12px] leading-relaxed", t.sub)}>
                {[
                  `${x.done} of ${x.total} written`,
                  x.changed && `${x.changed} changed since the preview`,
                  x.failedCount && `${x.failedCount} failed`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {x.error && <p class={clsx("text-[11px]", t.sub)}>{x.error}</p>}
            </div>
          );
        })}
      </div>
      {job.error && (
        <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.badBox)}>{job.error}</p>
      )}
      {failed.length > 0 && (
        <div class={clsx("rounded-lg px-3 py-2 text-[12px]", t.card)}>
          <button
            type="button"
            class="flex w-full items-center gap-2 text-left"
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? "down" : "chevron"} class={clsx("text-[12px]", t.faint)} />
            <span class={clsx("flex-1", t.heading)}>What failed</span>
            <span class={t.sub}>{failedCount}</span>
          </button>
          {open && (
            <ul class="mt-1.5 space-y-0.5 pl-5">
              {failed.map((f, i) => (
                <li key={`${f.tracker}:${i}`} class={t.sub}>
                  {f.title} · {trackerLabel(f.tracker)} · {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!running && (
        <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
          {job.auto
            ? "The automatic sync applied only the additions. Preview again to review the rest (removals, status changes, and conflicts)."
            : clean
              ? "Preview again to check: it should find nothing left to change."
              : "Preview again, then apply, to finish. Sync plans from what each tracker has now, so nothing is written twice."}
        </p>
      )}
    </div>
  );
}
