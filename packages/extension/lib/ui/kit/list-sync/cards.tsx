/** The List sync pane's cards: titles, setting rows, the automatic run line, and
 * the per-tracker read cards. */
import type { AutoRun } from "@/lib/sync/auto";
import type { TrackerRead } from "@/lib/sync/preview";
import type { SyncTotals } from "@/lib/sync/types";
import { trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
import type { ComponentChildren } from "preact";
import { Switch, type Tokens, TrackerMark } from "../kit";
import { FROM_LABEL, READ_LABEL, plural, totalParts } from "./labels";

/** The small uppercase title of a settings card. */
export function CardTitle({
  t,
  class: cls,
  children,
}: { t: Tokens; class?: string; children: ComponentChildren }) {
  return (
    <h3 class={clsx("text-[11px] font-semibold uppercase tracking-wider", t.faint, cls)}>
      {children}
    </h3>
  );
}

/** What the automatic sync does now: the step of a run in progress, and when the
 * next run is due (the alarm's time). */
export interface AutoNow {
  running?: "reading" | "applying";
  next?: number;
}

const WHEN: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

/** One line with a status dot: running now, on and waiting, or off. The dot colours
 * are the badge's (BadgeView). */
export function AutoStatus({ t, on, now }: { t: Tokens; on: boolean; now?: AutoNow }) {
  const running = now?.running;
  const text = running
    ? `Running now: ${running === "reading" ? "reading your lists" : "adding what each list is missing"}.`
    : !on
      ? "Off."
      : now?.next
        ? `On. Next run ${new Date(now.next).toLocaleString(undefined, WHEN)}.`
        : "On. The first run starts in about a minute.";
  return (
    <p class={clsx("flex items-center gap-2 text-[12px]", running || on ? t.heading : t.sub)}>
      <span
        class={clsx(
          "size-2 shrink-0 rounded-full",
          running ? "animate-pulse bg-emerald-500" : on ? "bg-emerald-500" : "bg-zinc-400",
        )}
      />
      {text}
    </p>
  );
}

/** What the last automatic run did, in a line or two. */
export function AutoLine({ t, run }: { t: Tokens; run: AutoRun }) {
  const when = new Date(run.at).toLocaleString(undefined, WHEN);
  const what =
    run.state === "skipped"
      ? `skipped. ${run.error ?? run.notes[0] ?? ""}`
      : run.state === "failed"
        ? `failed. ${run.error ?? ""}`
        : [
            run.added ? `added ${plural(run.added, "change")}` : "nothing to add",
            run.failed ? `${run.failed} failed` : "",
            run.held.length ? `${run.held.length} wait for review (preview to see them)` : "",
          ]
            .filter(Boolean)
            .join(", ");
  const notes = run.state === "skipped" ? [] : run.notes;
  return (
    <div class={clsx("text-[11px] leading-relaxed", t.sub)}>
      <p>
        Last run {when}: {what.trim()}
      </p>
      {notes.map((n) => (
        <p key={n} class={t.faint}>
          {n}
        </p>
      ))}
    </div>
  );
}

export function SettingRow({
  t,
  label,
  hint,
  on,
  onClick,
}: { t: Tokens; label: string; hint?: string; on: boolean; onClick: () => void }) {
  return (
    <div class="flex items-center justify-between gap-3">
      <span class="min-w-0">
        <span class={clsx("block text-[13px]", t.heading)}>{label}</span>
        {hint && <span class={clsx("block text-[11px]", t.sub)}>{hint}</span>}
      </span>
      <Switch t={t} on={on} onClick={onClick} />
    </div>
  );
}

/** One card per tracker: its read state, and (after a preview) what it would get. */
export function TrackerCards({
  t,
  reads,
  totals,
}: { t: Tokens; reads: TrackerRead[]; totals?: SyncTotals[] }) {
  return (
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {reads.map((r) => {
        const x = totals?.find((tt) => tt.tracker === r.tracker);
        const parts = x ? totalParts(x) : [];
        return (
          <div key={r.tracker} class={clsx("rounded-lg p-3", t.card)}>
            <div class="flex items-center gap-2">
              <TrackerMark tracker={r.tracker} />
              <span class={clsx("flex-1 text-[13px] font-semibold", t.heading)}>
                {trackerLabel(r.tracker)}
              </span>
              <span class={clsx("text-[11px]", t.faint)}>
                {r.state === "read"
                  ? plural(r.count ?? 0, "entry", "entries")
                  : READ_LABEL[r.state]}
              </span>
            </div>
            {r.from && <p class={clsx("mt-1 text-[11px]", t.faint)}>{FROM_LABEL[r.from]}</p>}
            {r.error && <p class={clsx("mt-1.5 text-[11px]", t.sub)}>{r.error}</p>}
            {x && (
              <p class={clsx("mt-1.5 text-[12px] leading-relaxed", t.sub)}>
                {parts.length ? parts.join(" · ") : "Nothing to add"}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
