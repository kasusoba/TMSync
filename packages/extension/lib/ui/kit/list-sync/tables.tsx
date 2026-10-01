import { STATUS_LABEL } from "@/lib/sync/describe";
/** The preview tabs other than the changes: notices, conflicts (with picks), skips, and the kept-out list. */
import { normStatus } from "@/lib/sync/plan/index";
import type { SyncPreview } from "@/lib/sync/preview";
import { outOfTen } from "@/lib/sync/score";
import {
  type SkipReason,
  type SyncConflict,
  type SyncNotice,
  type SyncPick,
  pickKey,
} from "@/lib/sync/types";
import type { CourStatus } from "@/lib/trackers/cour-plan";
import { type Tracker, trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
import { useState } from "preact/hooks";
import { Btn, Icon, type Tokens, TrackerMark } from "../kit";
import { Empty, Th } from "./ChangesTable";
import { NOTICE_LABEL, SKIP_LABEL } from "./labels";

export function NoticeTable({ t, notices }: { t: Tokens; notices: SyncNotice[] }) {
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

/** The value a tracker holds in a conflict, as a pick (a rewatch is completed). */
function valueAsPick(c: SyncConflict, tk: Tracker): SyncPick | undefined {
  const v = c.values.find((x) => x.tracker === tk)?.value;
  if (v === undefined) return undefined;
  return c.field === "status" ? normStatus(v as CourStatus) : Number(v);
}

export function ConflictTable({
  t,
  trackers,
  conflicts,
  onPick,
  onPickMany,
}: {
  t: Tokens;
  trackers: Tracker[];
  conflicts: SyncConflict[];
  onPick: (key: string, value: SyncPick | undefined) => void;
  /** Many picks at once (the bulk buttons), by `pickKey`. */
  onPickMany: (picks: Record<string, SyncPick | undefined>) => void;
}) {
  if (!conflicts.length) return null;
  // The trackers that hold a value in some conflict shown: each can be picked for all.
  const holders = trackers.filter((tk) => conflicts.some((c) => valueAsPick(c, tk) !== undefined));
  const pickAll = (tk: Tracker) => {
    const picks: Record<string, SyncPick | undefined> = {};
    for (const c of conflicts) {
      const v = valueAsPick(c, tk);
      if (v !== undefined) picks[pickKey(c)] = v;
    }
    onPickMany(picks);
  };
  const anyPicked = conflicts.some((c) => c.picked !== undefined);
  return (
    <div class="space-y-2">
      <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
        Pick the value every tracker should get. With no pick, sync writes nothing for that field. A
        status still follows the episodes: an entry sync finishes is completed, and one with watched
        episodes is never plan to watch.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <span class={clsx("text-[11px]", t.faint)}>Pick for all shown:</span>
        {holders.map((tk) => (
          <Btn key={tk} t={t} tone="ghost" onClick={() => pickAll(tk)}>
            <TrackerMark tracker={tk} class="size-3.5" /> {trackerLabel(tk)}’s value
          </Btn>
        ))}
        {anyPicked && (
          <Btn
            t={t}
            tone="ghost"
            onClick={() =>
              onPickMany(Object.fromEntries(conflicts.map((c) => [pickKey(c), undefined])))
            }
          >
            Clear picks
          </Btn>
        )}
      </div>
      <div class={clsx("overflow-x-auto rounded-lg", t.card)}>
        <table class="w-full min-w-[44rem] table-fixed text-[12px]">
          <colgroup>
            <col class="w-[24%]" />
            <col class="w-16" />
            {trackers.map((tk) => (
              <col key={tk} />
            ))}
            <col class="w-40" />
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
      class={clsx("w-full rounded-md px-1 py-1 text-[11px]", t.input)}
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

/** Pick one of the statuses the trackers have. No pick = no status is written. */
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
      class={clsx("w-full rounded-md px-1 py-1 text-[11px]", t.input)}
      title="The status every tracker gets"
    >
      <option value="">Leave alone</option>
      {statuses.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

export function SkipGroups({ t, skips }: { t: Tokens; skips: SyncPreview["plan"]["skips"] }) {
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

export function KeptList({
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
