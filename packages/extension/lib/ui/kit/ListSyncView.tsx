/**
 * The List sync pane (docs/ARCHITECTURE.md section 7), presentational: the options page and the
 * gallery feed it. A preview shows what each tracker is missing; Apply writes it,
 * after a confirm that says what will be removed first.
 *
 * Built for a wide pane: the changes are a table with one column per tracker, so a
 * long plan reads row by row. Tabs split changes, disagreements, skips, and the
 * items the user keeps out (which can be brought back from there).
 */
import { type ApplyBlock, type ApplyJob, type ApplyTracker, cleanApply } from "@/lib/sync/apply";
import type { AutoRun } from "@/lib/sync/auto";
import { normStatus, summarize, withPicks } from "@/lib/sync/plan";
import type { SyncPreview, TrackerRead } from "@/lib/sync/run";
import { outOfTen } from "@/lib/sync/score";
import type {
  EntryState,
  ListSyncSettings,
  SkipReason,
  SyncConflict,
  SyncItem,
  SyncKind,
  SyncNotice,
  SyncPick,
  SyncPicks,
  SyncPlan,
  SyncTotals,
  SyncWrite,
} from "@/lib/sync/types";
import { pickKey } from "@/lib/sync/types";
import type { CourStatus } from "@/lib/trackers/cour-plan";
import { type Tracker, trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Btn, Icon, IconBtn, Switch, type Tokens, TrackerMark } from "./kit";

const KIND_LABEL: Record<SyncKind, string> = { movie: "Movies", tv: "TV", anime: "Anime" };
const KINDS: SyncKind[] = ["movie", "tv", "anime"];

const STATUS_LABEL: Record<CourStatus, string> = {
  CURRENT: "Watching",
  PLANNING: "Plan to watch",
  COMPLETED: "Completed",
  PAUSED: "Paused",
  DROPPED: "Dropped",
  REPEATING: "Rewatching",
};

const SKIP_LABEL: Record<SkipReason, string> = {
  ignored: "You keep these out of sync",
  private: "Private on AniList",
  adult: "Adult entries",
  ambiguous: "The crosswalk can’t pick one entry",
  not_mapped: "Not in the anime crosswalk",
  numbering: "Episode numbers don’t match",
  no_id: "No id the tracker can use",
  main_missing: "The main list wasn’t read, so nothing of this kind is planned",
};

const NOTICE_LABEL: Record<SyncNotice["reason"], string> = {
  ahead: "Further than the main list. Sync never lowers progress.",
  history_kept: "Watch history. Sync never deletes it.",
  rating_kept: "A different rating. Sync only fills empty ratings.",
};

/** A short read, for a tracker that can tell what changed (`sync/cache.ts`). */
const FROM_LABEL: Record<NonNullable<TrackerRead["from"]>, string> = {
  saved: "No changes since the last read",
  changes: "Read only what changed",
};

const READ_LABEL: Record<TrackerRead["state"], string> = {
  waiting: "Waiting",
  reading: "Reading…",
  read: "Read",
  not_connected: "Not connected",
  off: "Off",
  failed: "Couldn’t read",
};

/** What an entry held, in a few words: "Plan to watch · 3/12 eps · rated 8/10". */
export function describeState(s: EntryState): string {
  const parts: string[] = [];
  if (s.status) parts.push(STATUS_LABEL[s.status]);
  if (s.progress !== undefined) parts.push(`${s.progress}/${s.total ?? "?"} eps`);
  if (s.episodes !== undefined) parts.push(`${s.episodes} watched`);
  if (s.watched !== undefined && !s.status) parts.push(s.watched ? "watched" : "not watched");
  if (s.rating != null) parts.push(`rated ${outOfTen(s.rating)}/10`);
  return parts.join(" · ") || "on the list";
}

/** One line of what a write does, for the preview. Each says what the tracker has
 * now ("had", "was"), so a change is never a surprise. */
export function describeWrite(w: SyncWrite): string {
  switch (w.op) {
    case "episodes": {
      const add = `+${w.add.length} episode${w.add.length === 1 ? "" : "s"}`;
      return w.was ? `${add} · had ${w.was.episodes ?? 0}` : `${add} · new`;
    }
    case "movie":
      return w.was?.status ? `mark watched · was ${STATUS_LABEL[w.was.status]}` : "mark watched";
    case "remove":
      return `remove · was ${describeState(w.was)}`;
    case "rating":
      return `rate ${outOfTen(w.score)}/10${w.level === "season" ? ` (season ${w.season})` : ""}${w.picked ? " · your pick" : ""}`;
    case "unrate":
      return `remove rating${w.level === "season" ? ` (season ${w.season})` : ""} · was ${outOfTen(w.was)}/10`;
    case "entry": {
      const parts: string[] = [w.create ? "add" : "update"];
      if (w.progress) parts.push(`${w.progress.from} → ${w.progress.to} eps`);
      if (w.status?.to) {
        parts.push(
          w.status.from
            ? `${STATUS_LABEL[w.status.from]} → ${STATUS_LABEL[w.status.to]}`
            : STATUS_LABEL[w.status.to],
        );
      }
      if (w.repeat) parts.push(`${w.repeat.to} rewatches`);
      return parts.join(" · ");
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The kinds a tracker can take, with the user's choice. */
export interface KindRow {
  tracker: Tracker;
  /** What it can take at all. */
  can: SyncKind[];
  /** What it takes now. */
  on: SyncKind[];
}

export function ListSyncView({
  t,
  rows,
  settings,
  preview,
  progress,
  busy,
  error,
  onPreview,
  onKind,
  onSetting,
  onMain,
  onIgnore,
  onRestore,
  onClearIgnored,
  picks = {},
  apply = null,
  applying = false,
  blocked = null,
  onApply = () => {},
  onCancelApply = () => {},
  onPick = () => {},
  autoRun = null,
}: {
  t: Tokens;
  rows: KindRow[];
  settings: ListSyncSettings;
  /** The last preview, as planned (items the user kept out since are hidden here). */
  preview: SyncPreview | null;
  /** Each tracker's state while a preview runs. */
  progress?: TrackerRead[];
  busy: boolean;
  error?: string;
  /** What the user picked where trackers disagree, by `pickKey`. */
  picks?: SyncPicks;
  /** The last apply: its progress while it runs, then its summary. */
  apply?: ApplyJob | null;
  /** An apply is running now. */
  applying?: boolean;
  /** Why the preview can't be applied now (null = it can). */
  blocked?: ApplyBlock | null;
  onApply?: () => void;
  onCancelApply?: () => void;
  /** Pick in a disagreement, by `pickKey` (undefined = no pick). */
  onPick?: (key: string, value: SyncPick | undefined) => void;
  onPreview: () => void;
  onKind: (tracker: Tracker, kind: SyncKind, on: boolean) => void;
  onSetting: (key: "includePrivate" | "includeAdult" | "auto", on: boolean) => void;
  /** The last automatic run (null = none yet). */
  autoRun?: AutoRun | null;
  /** Set (or clear, with undefined) the main list of a kind. */
  onMain: (kind: SyncKind, tracker: Tracker | undefined) => void;
  onIgnore: (key: string) => void;
  onRestore: (key: string) => void;
  onClearIgnored: () => void;
}) {
  return (
    <div class="space-y-5">
      <p class={clsx("max-w-2xl text-[12px] leading-relaxed", t.sub)}>
        Keep your lists in sync. TMSync reads each connected list and works out what the others are
        missing: watched episodes, list status, and ratings. What you remove from one list after a
        sync is removed from the others, not added back. Pick a main list for a kind to make the
        others copy it instead. Preview first: nothing is written until you apply the plan.
      </p>

      <div class="grid gap-3 lg:grid-cols-[3fr_2fr]">
        <section class={clsx("rounded-lg p-3", t.card)}>
          <CardTitle t={t} class="mb-2">
            What each tracker syncs
          </CardTitle>
          <table class="w-full text-[12px]">
            <thead>
              <tr class={t.faint}>
                <th class="pb-1.5 text-left font-medium" />
                {KINDS.map((k) => (
                  <th key={k} class="w-20 pb-1.5 text-center font-medium">
                    {KIND_LABEL[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tracker}>
                  <td class="py-1.5">
                    <span class={clsx("flex items-center gap-2 font-medium", t.heading)}>
                      <TrackerMark tracker={r.tracker} />
                      {trackerLabel(r.tracker)}
                    </span>
                  </td>
                  {KINDS.map((k) => (
                    <td key={k} class="py-1.5 text-center">
                      {r.can.includes(k) ? (
                        <span class="inline-flex">
                          <Switch
                            t={t}
                            on={r.on.includes(k)}
                            onClick={() => onKind(r.tracker, k, !r.on.includes(k))}
                          />
                        </span>
                      ) : (
                        <span class={t.faint}>·</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              <tr class={clsx("border-t", t.divider)}>
                <td class={clsx("pt-2.5 font-medium", t.heading)}>Main list</td>
                {KINDS.map((k) => {
                  const able = rows.filter((r) => r.can.includes(k) && r.on.includes(k));
                  const cur = settings.main?.[k];
                  return (
                    <td key={k} class="pt-2.5 text-center">
                      <select
                        value={cur ?? ""}
                        onChange={(e) => {
                          const v = (e.target as HTMLSelectElement).value;
                          onMain(k, v ? (v as Tracker) : undefined);
                        }}
                        class={clsx("w-[4.75rem] rounded-md px-1 py-1 text-[11px]", t.input)}
                        title={`Main list for ${KIND_LABEL[k]}`}
                      >
                        <option value="">None</option>
                        {able.map((r) => (
                          <option key={r.tracker} value={r.tracker}>
                            {trackerLabel(r.tracker)}
                          </option>
                        ))}
                      </select>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
          <p class={clsx("mt-2 text-[11px] leading-relaxed", t.sub)}>
            None: every list gets what the others have, and an entry or a rating you remove from one
            list is removed from the others. A main list: the others copy it, and lose list entries
            it doesn’t have. Progress never goes down and Trakt history is never deleted. The
            preview lists what stays as it is.
          </p>
        </section>

        <div class="flex flex-col gap-3">
          <section class={clsx("flex flex-col gap-3 rounded-lg p-3", t.card)}>
            <CardTitle t={t}>Include</CardTitle>
            <SettingRow
              t={t}
              label="Private AniList entries"
              hint="Off: an entry you made private stays off your other (maybe public) profiles."
              on={settings.includePrivate}
              onClick={() => onSetting("includePrivate", !settings.includePrivate)}
            />
            <SettingRow
              t={t}
              label="Adult entries"
              on={settings.includeAdult}
              onClick={() => onSetting("includeAdult", !settings.includeAdult)}
            />
          </section>

          <section class={clsx("flex flex-col gap-3 rounded-lg p-3", t.card)}>
            <CardTitle t={t}>Automatic sync</CardTitle>
            <SettingRow
              t={t}
              label="Sync once a day"
              hint="Adds only: episodes, movies, new entries, progress, and empty ratings. Removals and conflicts wait for you, and the toolbar icon counts them."
              on={!!settings.auto}
              onClick={() => onSetting("auto", !settings.auto)}
            />
            {settings.auto && autoRun && <AutoLine t={t} run={autoRun} />}
          </section>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <Btn t={t} tone="primary" disabled={busy || applying} onClick={onPreview}>
          <Icon name="refresh" class="text-[12px]" />{" "}
          {busy ? "Reading your lists…" : "Preview sync"}
        </Btn>
      </div>

      {error && <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.badBox)}>{error}</p>}

      {/* The result, set apart from the settings above it. */}
      {((busy && progress && progress.length > 0) || (preview && !busy)) && (
        <section class={clsx("space-y-4 border-t pt-5", t.divider)}>
          <h3
            class={clsx(
              "flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wider",
              t.faint,
            )}
          >
            {busy ? "Reading your lists" : preview?.auto ? "Automatic sync" : "Preview"}
            {preview && !busy && (
              <span class="font-normal normal-case tracking-normal">
                read {new Date(preview.at).toLocaleTimeString()}
              </span>
            )}
          </h3>
          {busy && progress && <TrackerCards t={t} reads={progress} />}
          {preview && !busy && (
            <PreviewResult
              t={t}
              preview={preview}
              ignore={settings.ignore}
              onIgnore={onIgnore}
              onRestore={onRestore}
              onClearIgnored={onClearIgnored}
              picks={picks}
              apply={apply}
              applying={applying}
              blocked={blocked}
              onApply={onApply}
              onCancelApply={onCancelApply}
              onPick={onPick}
            />
          )}
        </section>
      )}
    </div>
  );
}

/** The small uppercase title of a settings card. */
function CardTitle({
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

/** What the last automatic run did, in a line or two. */
function AutoLine({ t, run }: { t: Tokens; run: AutoRun }) {
  const when = new Date(run.at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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
        Last automatic sync, {when}: {what.trim()}
      </p>
      {notes.map((n) => (
        <p key={n} class={t.faint}>
          {n}
        </p>
      ))}
    </div>
  );
}

function SettingRow({
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

/** What a tracker gets, in short parts: "+12 episodes", "3 ratings". */
function totalParts(x: SyncTotals, removals = true): string[] {
  return [
    x.episodes && `+${plural(x.episodes, "episode")}`,
    x.movies && `+${plural(x.movies, "movie")}`,
    x.created && plural(x.created, "new entry", "new entries"),
    x.updated && `${x.updated} updated`,
    x.ratings && plural(x.ratings, "rating"),
    removals && x.removed && `${x.removed} removed`,
    removals && x.unrated && `${plural(x.unrated, "rating")} removed`,
  ].filter((p): p is string => !!p);
}

const BLOCK_LABEL: Record<ApplyBlock, string> = {
  running: "An apply is running.",
  previewing: "A preview is running.",
  no_plan: "Preview first.",
  spent: "This preview was applied. Preview again to see what is left.",
  stale:
    "This preview is more than 10 minutes old. Preview again before you apply, so the plan matches your lists.",
  nothing: "Nothing to apply: your lists already match.",
};

/**
 * Apply, with a confirm that repeats what will happen. Removals come first and
 * stand out: they are the one change that takes something away.
 */
function ApplyBar({
  t,
  plan,
  kept,
  totals,
  blocked,
  onApply,
}: {
  t: Tokens;
  plan: SyncPlan;
  kept: Set<string>;
  totals: SyncTotals[];
  blocked: ApplyBlock | null;
  onApply: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  if (blocked) {
    return (
      <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>{BLOCK_LABEL[blocked]}</p>
    );
  }
  const writes = plan.items.filter((i) => !kept.has(i.key)).flatMap((i) => i.writes).length;
  const removals = totals.filter((x) => x.removed || x.unrated);
  if (!confirm) {
    return (
      <div class={clsx("flex items-center gap-3 rounded-lg p-3", t.card)}>
        <span class={clsx("flex-1 text-[12px]", t.sub)}>
          The plan is ready: {plural(writes, "change")} across your trackers.
        </span>
        <Btn t={t} tone="primary" onClick={() => setConfirm(true)}>
          Apply changes
        </Btn>
      </div>
    );
  }
  return (
    <div class={clsx("space-y-2.5 rounded-lg p-3", t.card)}>
      <p class={clsx("text-[13px] font-semibold", t.heading)}>Apply this plan?</p>
      {removals.length > 0 && (
        <p class={clsx("rounded-md px-2.5 py-1.5 text-[12px] leading-relaxed", t.badBox)}>
          Removes{" "}
          {removals
            .map((x) =>
              [
                x.removed && plural(x.removed, "entry", "entries"),
                x.unrated && plural(x.unrated, "rating"),
              ]
                .filter(Boolean)
                .join(" and "),
            )
            .map((what, i) => `${what} from ${trackerLabel((removals[i] as SyncTotals).tracker)}`)
            .join(", ")}
          . A removed entry loses its progress, status, and rating there.
        </p>
      )}
      <ul class={clsx("space-y-0.5 text-[12px]", t.sub)}>
        {totals.map((x) => {
          const parts = totalParts(x, false);
          return parts.length ? (
            <li key={x.tracker} class="flex items-center gap-2">
              <TrackerMark tracker={x.tracker} />
              <span class={t.heading}>{trackerLabel(x.tracker)}</span>
              <span>{parts.join(" · ")}</span>
            </li>
          ) : null;
        })}
      </ul>
      <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
        Each write stands on its own, so you can stop at any time and keep what was written. New
        watches on Trakt and Simkl get the date the other list last changed, or the air date when
        that is unknown.
      </p>
      <div class="flex gap-2">
        <Btn
          t={t}
          tone="primary"
          onClick={() => {
            setConfirm(false);
            onApply();
          }}
        >
          Apply
        </Btn>
        <Btn t={t} tone="ghost" onClick={() => setConfirm(false)}>
          Back
        </Btn>
      </div>
    </div>
  );
}

const APPLY_STATE: Record<ApplyTracker["state"], string> = {
  waiting: "Waiting",
  running: "Writing…",
  done: "Done",
  stopped: "Stopped",
  cancelled: "Stopped",
};

/** An apply: each tracker's progress while it runs, then what was written. */
function ApplyProgress({
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

/** One card per tracker: its read state, and (after a preview) what it would get. */
function TrackerCards({
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

type Tab = "changes" | "removals" | "notices" | "conflicts" | "skipped" | "kept";

const isRemoval = (i: SyncItem) => i.writes.every((w) => w.op === "remove" || w.op === "unrate");

const PAGE = 100;

function PreviewResult({
  t,
  preview,
  ignore,
  onIgnore,
  onRestore,
  onClearIgnored,
  picks,
  apply,
  applying,
  blocked,
  onApply,
  onCancelApply,
  onPick,
}: {
  t: Tokens;
  preview: SyncPreview;
  ignore: string[];
  onIgnore: (key: string) => void;
  onRestore: (key: string) => void;
  onClearIgnored: () => void;
  picks: SyncPicks;
  apply: ApplyJob | null;
  applying: boolean;
  blocked: ApplyBlock | null;
  onApply: () => void;
  onCancelApply: () => void;
  onPick: (key: string, value: SyncPick | undefined) => void;
}) {
  const [tab, setTab] = useState<Tab>("changes");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<SyncKind | "all">("all");
  const [shown, setShown] = useState(PAGE);
  /** The item just kept out, for the one-click undo. */
  const [undo, setUndo] = useState<{ key: string; title: string } | null>(null);

  // The plan as it will be applied: the user's picks in, kept-out items out.
  const plan = withPicks(preview.plan, picks, preview.scales);
  const kept = new Set(ignore);
  const trackers = preview.reads.filter((r) => r.state === "read").map((r) => r.tracker);
  const totals = summarize(
    { ...plan, items: plan.items.filter((i) => !kept.has(i.key)) },
    trackers,
  );
  // This preview's apply, if it had one (a new preview starts clean).
  const ran = apply?.planAt === preview.at ? apply : null;
  const match = (title: string, k?: SyncKind) =>
    title.toLowerCase().includes(q.trim().toLowerCase()) && (kind === "all" || k === kind);

  const live = plan.items.filter((i) => !kept.has(i.key));
  const items = live.filter((i) => !isRemoval(i) && match(i.title, i.kind));
  const removals = live.filter((i) => isRemoval(i) && match(i.title, i.kind));
  const notices = plan.notices.filter((n) => !kept.has(n.key) && match(n.title, n.kind));
  const conflicts = plan.conflicts.filter((c) => !kept.has(c.key) && match(c.title));
  const skips = plan.skips.filter((s) => s.reason !== "ignored" && match(s.title));
  // A kept-out item's name: from this plan when it is there, else its key.
  const titles = new Map<string, string>();
  for (const i of plan.items) titles.set(i.key, i.title);
  for (const s of plan.skips) if (s.title) titles.set(s.key, s.title);
  const keptRows = ignore.map((key) => ({ key, title: titles.get(key) ?? key }));

  const more = () => setShown(shown + PAGE * 5);

  const keepOut = (item: SyncItem) => {
    onIgnore(item.key);
    setUndo({ key: item.key, title: item.title });
  };

  const tabs: { id: Tab; label: string; n: number }[] = [
    { id: "changes", label: "Changes", n: live.filter((i) => !isRemoval(i)).length },
    { id: "removals", label: "Removals", n: live.filter(isRemoval).length },
    { id: "notices", label: "Left as is", n: plan.notices.filter((n) => !kept.has(n.key)).length },
    {
      id: "conflicts",
      label: "Conflicts",
      n: plan.conflicts.filter((c) => !kept.has(c.key)).length,
    },
    { id: "skipped", label: "Skipped", n: plan.skips.filter((s) => s.reason !== "ignored").length },
    { id: "kept", label: "Kept out", n: ignore.length },
  ];

  return (
    <div class="space-y-4">
      <TrackerCards t={t} reads={preview.reads} totals={totals} />

      {ran ? (
        <ApplyProgress t={t} job={ran} running={applying} onCancel={onCancelApply} />
      ) : (
        !preview.reason && (
          <ApplyBar
            t={t}
            plan={plan}
            kept={kept}
            totals={totals}
            blocked={blocked}
            onApply={onApply}
          />
        )
      )}

      {preview.noCrosswalk && (
        <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
          The anime crosswalk isn’t downloaded yet, so anime can’t move between Trakt and AniList or
          MyAnimeList. Refresh the library and preview again.
        </p>
      )}
      {preview.reason === "too_few" && (
        <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
          Sync needs at least two trackers. Connect another in Account, or turn one on above.
        </p>
      )}

      <div class={clsx("flex flex-wrap items-center gap-3 border-b pb-2", t.divider)}>
        <div class="flex gap-1">
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => setTab(x.id)}
              class={clsx(
                "rounded-lg px-2.5 py-1.5 text-[12px] transition-colors",
                tab === x.id
                  ? clsx(t.card, t.heading, "font-medium")
                  : clsx(t.sub, "hover:bg-white/5"),
              )}
            >
              {x.label}
              <span
                class={clsx("ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums", t.chip)}
              >
                {x.n}
              </span>
            </button>
          ))}
        </div>
        {tab !== "kept" && (
          <div class="ml-auto flex items-center gap-2">
            {tab !== "conflicts" && tab !== "skipped" && (
              <div class={clsx("flex gap-0.5 rounded-lg p-0.5", t.card)}>
                {(["all", ...KINDS] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    class={clsx(
                      "rounded-md px-2 py-1 text-[11px]",
                      kind === k ? clsx(t.chip, t.heading) : t.sub,
                    )}
                  >
                    {k === "all" ? "All" : KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            )}
            <div class={clsx("flex w-56 items-center gap-2 rounded-lg px-2.5", t.input)}>
              <Icon name="search" class={clsx("text-[13px]", t.faint)} />
              <input
                value={q}
                onInput={(e) => {
                  setQ((e.target as HTMLInputElement).value);
                  setShown(PAGE);
                }}
                placeholder="Filter by title"
                class="w-full bg-transparent py-1.5 text-[12px] outline-none"
              />
            </div>
          </div>
        )}
      </div>

      {undo && kept.has(undo.key) && (
        <div class={clsx("flex items-center gap-3 rounded-md px-3 py-2 text-[12px]", t.infoBox)}>
          <span class="flex-1">Kept “{undo.title}” out of sync.</span>
          <Btn
            t={t}
            tone="ghost"
            onClick={() => {
              onRestore(undo.key);
              setUndo(null);
            }}
          >
            Undo
          </Btn>
        </div>
      )}

      {tab === "changes" && (
        <ChangesTable t={t} trackers={trackers} items={items.slice(0, shown)} onKeepOut={keepOut} />
      )}
      {tab === "changes" && <ShowMore t={t} left={items.length - shown} onMore={more} />}
      {tab === "changes" && !items.length && <Empty t={t} text="Nothing to change." />}

      {tab === "removals" && (
        <>
          {removals.length > 0 && (
            <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
              Sync would remove these from your other lists: your main list doesn’t have them, or
              you removed them from one list since the last sync. Keep one out of sync to leave it
              where it is.
            </p>
          )}
          <ChangesTable
            t={t}
            trackers={trackers}
            items={removals.slice(0, shown)}
            onKeepOut={keepOut}
          />
          <ShowMore t={t} left={removals.length - shown} onMore={more} />
          {!removals.length && <Empty t={t} text="Nothing to remove." />}
        </>
      )}

      {tab === "notices" && <NoticeTable t={t} notices={notices} />}
      {tab === "notices" && !notices.length && <Empty t={t} text="Nothing is left as is." />}

      {tab === "conflicts" && (
        <ConflictTable t={t} trackers={trackers} conflicts={conflicts} onPick={onPick} />
      )}
      {tab === "conflicts" && !conflicts.length && <Empty t={t} text="No conflicts." />}

      {tab === "skipped" && <SkipGroups t={t} skips={skips} />}
      {tab === "skipped" && !skips.length && <Empty t={t} text="Nothing was skipped." />}

      {tab === "kept" && (
        <KeptList t={t} rows={keptRows} onRestore={onRestore} onClearIgnored={onClearIgnored} />
      )}
    </div>
  );
}

/**
 * A header cell that stays at the top of the window while its table scrolls, so
 * the tracker of each column is always in view. The cell is opaque, and its
 * bottom line is inside it: a row border would not move with a sticky cell.
 */
function Th({ t, children }: { t: Tokens; children?: ComponentChildren }) {
  return (
    <th class={clsx("sticky top-0 z-10 p-0 align-bottom font-medium", t.cardSolid)}>
      <div class={clsx("flex h-9 items-center border-b px-3", t.divider)}>{children}</div>
    </th>
  );
}

/** "Show more" under a long table, while rows are left. */
function ShowMore({ t, left, onMore }: { t: Tokens; left: number; onMore: () => void }) {
  if (left <= 0) return null;
  return (
    <Btn t={t} tone="ghost" onClick={onMore}>
      Show more ({left} left)
    </Btn>
  );
}

function Empty({ t, text }: { t: Tokens; text: string }) {
  return <p class={clsx("py-6 text-center text-[12px]", t.faint)}>{text}</p>;
}

/** The plan as a table: one row per item, one column per tracker. */
function ChangesTable({
  t,
  trackers,
  items,
  onKeepOut,
}: {
  t: Tokens;
  trackers: Tracker[];
  items: SyncItem[];
  onKeepOut: (item: SyncItem) => void;
}) {
  if (!items.length) return null;
  return (
    <div class={clsx("overflow-x-clip rounded-lg", t.card)}>
      {/* Fixed layout: the columns keep their width whatever rows a filter shows. */}
      <table class="w-full table-fixed text-[12px]">
        <colgroup>
          <col class="w-[30%]" />
          {trackers.map((tk) => (
            <col key={tk} />
          ))}
          <col class="w-10" />
        </colgroup>
        <thead>
          <tr class={clsx("text-left", t.faint)}>
            <Th t={t}>Title</Th>
            {trackers.map((tk) => (
              <Th t={t} key={tk}>
                <span class="flex items-center gap-1.5">
                  <TrackerMark tracker={tk} />
                  {trackerLabel(tk)}
                </span>
              </Th>
            ))}
            <Th t={t} />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key} class={clsx("border-b align-top last:border-b-0", t.divider)}>
              <td class="px-3 py-2">
                <span class={clsx("block", t.heading)}>
                  {item.title}
                  {item.year ? <span class={t.faint}> ({item.year})</span> : null}
                </span>
                <span class={clsx("mt-0.5 inline-block rounded px-1 py-0.5 text-[10px]", t.chip)}>
                  {KIND_LABEL[item.kind]}
                </span>
              </td>
              {trackers.map((tk) => {
                const ws = item.writes.filter((w) => w.tracker === tk);
                return (
                  <td key={tk} class={clsx("px-3 py-2", t.sub)}>
                    {ws.length ? (
                      ws.map((w) => (
                        <span key={w.op} class="block">
                          {describeWrite(w)}
                        </span>
                      ))
                    ) : (
                      <span class={t.faint}>·</span>
                    )}
                  </td>
                );
              })}
              <td class="px-1 py-1.5">
                <IconBtn
                  t={t}
                  name="eye-off"
                  title="Keep this item out of sync"
                  onClick={() => onKeepOut(item)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoticeTable({ t, notices }: { t: Tokens; notices: SyncNotice[] }) {
  if (!notices.length) return null;
  return (
    <div class="space-y-2">
      <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
        Sync leaves these copies as they are, because changing them would lower progress, delete
        watch history, or replace a rating. Fix them by hand on the tracker if you want them to
        match.
      </p>
      <div class={clsx("overflow-x-clip rounded-lg", t.card)}>
        <table class="w-full table-fixed text-[12px]">
          <colgroup>
            <col class="w-[30%]" />
            <col class="w-36" />
            <col />
          </colgroup>
          <thead>
            <tr class={clsx("text-left", t.faint)}>
              <Th t={t}>Title</Th>
              <Th t={t}>Tracker</Th>
              <Th t={t}>Why</Th>
            </tr>
          </thead>
          <tbody>
            {notices.map((n) => (
              <tr
                key={`${n.key}:${n.tracker}:${n.reason}`}
                class={clsx("border-b align-top last:border-b-0", t.divider)}
              >
                <td class={clsx("truncate px-3 py-2", t.heading)}>{n.title}</td>
                <td class="px-3 py-2">
                  <span class={clsx("flex items-center gap-1.5", t.sub)}>
                    <TrackerMark tracker={n.tracker} />
                    {trackerLabel(n.tracker)}
                  </span>
                </td>
                <td class={clsx("px-3 py-2", t.sub)}>
                  {NOTICE_LABEL[n.reason]}
                  {n.detail && <span class={clsx("block", t.faint)}>{n.detail}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function conflictValue(c: SyncConflict, v: string | number): string {
  return c.field === "status" ? STATUS_LABEL[v as CourStatus] : `${outOfTen(Number(v))}/10`;
}

function ConflictTable({
  t,
  trackers,
  conflicts,
  onPick,
}: {
  t: Tokens;
  trackers: Tracker[];
  conflicts: SyncConflict[];
  onPick: (key: string, value: SyncPick | undefined) => void;
}) {
  if (!conflicts.length) return null;
  return (
    <div class="space-y-2">
      <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
        Pick the value every tracker should get. With no pick, the most recent status change wins,
        and different ratings are left alone. A status still follows the episodes: an entry sync
        finishes is completed, and one with watched episodes is never plan to watch.
      </p>
      <div class={clsx("overflow-x-clip rounded-lg", t.card)}>
        <table class="w-full table-fixed text-[12px]">
          <colgroup>
            <col class="w-[30%]" />
            <col class="w-20" />
            {trackers.map((tk) => (
              <col key={tk} />
            ))}
            <col />
          </colgroup>
          <thead>
            <tr class={clsx("text-left", t.faint)}>
              <Th t={t}>Title</Th>
              <Th t={t}>Field</Th>
              {trackers.map((tk) => (
                <Th t={t} key={tk}>
                  {trackerLabel(tk)}
                </Th>
              ))}
              <Th t={t}>Result</Th>
            </tr>
          </thead>
          <tbody>
            {conflicts.map((c) => (
              <tr key={`${c.key}:${c.field}`} class={clsx("border-b last:border-b-0", t.divider)}>
                <td class={clsx("px-3 py-2", t.heading)}>{c.title}</td>
                <td class={clsx("px-3 py-2", t.sub)}>
                  {c.field === "status" ? "Status" : "Rating"}
                </td>
                {trackers.map((tk) => {
                  const v = c.values.find((x) => x.tracker === tk);
                  return (
                    <td key={tk} class={clsx("px-3 py-2", v ? t.sub : t.faint)}>
                      {v ? conflictValue(c, v.value) : "·"}
                    </td>
                  );
                })}
                <td class={clsx("px-3 py-1.5", t.heading)}>
                  {c.field === "rating" && c.refs?.length ? (
                    <RatingPick t={t} c={c} onPick={onPick} />
                  ) : c.field === "status" && c.targets?.length ? (
                    <StatusPick t={t} c={c} onPick={onPick} />
                  ) : c.chosen ? (
                    conflictValue(c, c.chosen.value)
                  ) : (
                    "Left alone"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Pick one of the scores the trackers have, or leave the rating alone. */
function RatingPick({
  t,
  c,
  onPick,
}: { t: Tokens; c: SyncConflict; onPick: (key: string, value: SyncPick | undefined) => void }) {
  // The scores on offer, on the 1 to 10 scale most trackers use, highest first.
  const scores = [...new Set(c.values.map((v) => Math.round(Number(v.value) / 10) * 10))].sort(
    (a, b) => b - a,
  );
  const picked = typeof c.picked === "number" ? c.picked : undefined;
  if (picked !== undefined && !scores.includes(picked)) scores.unshift(picked);
  return (
    <select
      value={picked ?? ""}
      onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        onPick(pickKey(c), v ? Number(v) : undefined);
      }}
      class={clsx("rounded-md px-1 py-1 text-[11px]", t.input)}
      title="The rating every tracker gets"
    >
      <option value="">Leave alone</option>
      {scores.map((s) => (
        <option key={s} value={s}>
          {outOfTen(s)}/10
        </option>
      ))}
    </select>
  );
}

/** Pick one of the statuses the trackers have. No pick = the most recent change
 * wins (the planner's choice, named in the first option). */
function StatusPick({
  t,
  c,
  onPick,
}: { t: Tokens; c: SyncConflict; onPick: (key: string, value: SyncPick | undefined) => void }) {
  // A rewatch reads as completed across trackers, as the planner compares them.
  const statuses = [...new Set(c.values.map((v) => normStatus(v.value as CourStatus)))];
  const picked = typeof c.picked === "string" ? c.picked : undefined;
  return (
    <select
      value={picked ?? ""}
      onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        onPick(pickKey(c), v ? (v as CourStatus) : undefined);
      }}
      class={clsx("rounded-md px-1 py-1 text-[11px]", t.input)}
      title="The status every tracker gets"
    >
      <option value="">
        Most recent{c.chosen ? ` (${STATUS_LABEL[c.chosen.value as CourStatus]})` : ""}
      </option>
      {statuses.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

function SkipGroups({ t, skips }: { t: Tokens; skips: SyncPreview["plan"]["skips"] }) {
  const reasons = [...new Set(skips.map((s) => s.reason))];
  if (!reasons.length) return null;
  return (
    <div class={clsx("divide-y rounded-lg", t.card, t.divider)}>
      {reasons.map((reason) => (
        <SkipGroup
          key={reason}
          t={t}
          reason={reason}
          skips={skips.filter((s) => s.reason === reason)}
        />
      ))}
    </div>
  );
}

function SkipGroup({
  t,
  reason,
  skips,
}: { t: Tokens; reason: SkipReason; skips: SyncPreview["plan"]["skips"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={clsx("px-3 py-2 text-[12px]", t.divider)}>
      <button
        type="button"
        class="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? "down" : "chevron"} class={clsx("text-[12px]", t.faint)} />
        <span class={clsx("flex-1", t.heading)}>{SKIP_LABEL[reason]}</span>
        <span class={t.sub}>{skips.length}</span>
      </button>
      {open && (
        <ul class="mt-1.5 grid gap-x-6 gap-y-0.5 pl-5 md:grid-cols-2">
          {skips.slice(0, 500).map((s) => (
            <li key={`${s.key}:${s.tracker ?? ""}:${s.detail ?? ""}`} class={t.sub}>
              {s.title || s.key}
              {s.tracker ? ` · ${trackerLabel(s.tracker)}` : ""}
              {s.detail ? ` · ${s.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KeptList({
  t,
  rows,
  onRestore,
  onClearIgnored,
}: {
  t: Tokens;
  rows: { key: string; title: string }[];
  onRestore: (key: string) => void;
  onClearIgnored: () => void;
}) {
  if (!rows.length) return <Empty t={t} text="You keep nothing out of sync." />;
  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <p class={clsx("text-[11px]", t.sub)}>
          Sync leaves these alone. Bring one back to include it in the next preview.
        </p>
        <Btn t={t} tone="ghost" onClick={onClearIgnored}>
          Bring all back
        </Btn>
      </div>
      <div class={clsx("divide-y rounded-lg", t.card, t.divider)}>
        {rows.map((r) => (
          <div
            key={r.key}
            class={clsx("flex items-center gap-3 px-3 py-1.5 text-[12px]", t.divider)}
          >
            <span class={clsx("min-w-0 flex-1 truncate", t.heading)}>{r.title}</span>
            <Btn t={t} tone="ghost" onClick={() => onRestore(r.key)}>
              Bring back
            </Btn>
          </div>
        ))}
      </div>
    </div>
  );
}
