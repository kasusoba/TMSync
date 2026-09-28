/**
 * The List sync pane (plans/list-sync.md), presentational: the options page and the
 * gallery feed it. Phase 1 previews only: it shows what each tracker is missing,
 * and nothing is written.
 *
 * Built for a wide pane: the changes are a table with one column per tracker, so a
 * long plan reads row by row. Tabs split changes, disagreements, skips, and the
 * items the user keeps out (which can be brought back from there).
 */
import type { SyncPreview, TrackerRead } from "@/lib/sync/run";
import type {
  ListSyncSettings,
  SkipReason,
  SyncConflict,
  SyncItem,
  SyncKind,
  SyncWrite,
} from "@/lib/sync/types";
import type { CourStatus } from "@/lib/trackers/cour-plan";
import { type Tracker, trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
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
};

const READ_LABEL: Record<TrackerRead["state"], string> = {
  waiting: "Waiting",
  reading: "Reading…",
  read: "Read",
  not_connected: "Not connected",
  off: "Off",
  failed: "Couldn’t read",
};

/** One line of what a write does, for the preview. */
export function describeWrite(w: SyncWrite): string {
  switch (w.op) {
    case "episodes":
      return `+${w.add.length} episode${w.add.length === 1 ? "" : "s"}`;
    case "movie":
      return "mark watched";
    case "rating":
      return `rate ${Math.round(w.score) / 10}/10${w.level === "season" ? ` (season ${w.season})` : ""}`;
    case "entry": {
      const parts: string[] = [w.create ? "add" : "update"];
      if (w.progress) parts.push(`${w.progress.from} → ${w.progress.to} eps`);
      if (w.status?.to) parts.push(STATUS_LABEL[w.status.to]);
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
  onIgnore,
  onRestore,
  onClearIgnored,
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
  onPreview: () => void;
  onKind: (tracker: Tracker, kind: SyncKind, on: boolean) => void;
  onSetting: (key: "includePrivate" | "includeAdult", on: boolean) => void;
  onIgnore: (key: string) => void;
  onRestore: (key: string) => void;
  onClearIgnored: () => void;
}) {
  return (
    <div class="space-y-5">
      <p class={clsx("max-w-2xl text-[12px] leading-relaxed", t.sub)}>
        Make your trackers agree. TMSync reads each connected list and works out what the others are
        missing: watched episodes, list status, and ratings. It only adds, it never removes. This
        version shows the plan only. Nothing is written to your trackers yet.
      </p>

      <div class="grid gap-3 lg:grid-cols-[3fr_2fr]">
        <section class={clsx("rounded-lg p-3", t.card)}>
          <h3 class={clsx("mb-2 text-[11px] font-semibold uppercase tracking-wider", t.faint)}>
            What each tracker syncs
          </h3>
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
            </tbody>
          </table>
        </section>

        <section class={clsx("flex flex-col gap-3 rounded-lg p-3", t.card)}>
          <SettingRow
            t={t}
            label="Include private AniList entries"
            hint="Off: an entry you made private stays off your other (maybe public) profiles."
            on={settings.includePrivate}
            onClick={() => onSetting("includePrivate", !settings.includePrivate)}
          />
          <SettingRow
            t={t}
            label="Include adult entries"
            on={settings.includeAdult}
            onClick={() => onSetting("includeAdult", !settings.includeAdult)}
          />
          <div class="mt-auto flex items-center gap-3 pt-1">
            <Btn t={t} tone="primary" disabled={busy} onClick={onPreview}>
              <Icon name="refresh" class="text-[12px]" />{" "}
              {busy ? "Reading your lists…" : "Preview sync"}
            </Btn>
            {preview && !busy && (
              <span class={clsx("text-[11px]", t.faint)}>
                Read {new Date(preview.at).toLocaleTimeString()}
              </span>
            )}
          </div>
        </section>
      </div>

      {error && <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.badBox)}>{error}</p>}
      {busy && progress && progress.length > 0 && <TrackerCards t={t} reads={progress} />}
      {preview && !busy && (
        <PreviewResult
          t={t}
          preview={preview}
          ignore={settings.ignore}
          onIgnore={onIgnore}
          onRestore={onRestore}
          onClearIgnored={onClearIgnored}
        />
      )}
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

/** One card per tracker: its read state, and (after a preview) what it would get. */
function TrackerCards({
  t,
  reads,
  preview,
}: { t: Tokens; reads: TrackerRead[]; preview?: SyncPreview }) {
  return (
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {reads.map((r) => {
        const x = preview?.totals.find((tt) => tt.tracker === r.tracker);
        const parts = x
          ? [
              x.episodes && `+${plural(x.episodes, "episode")}`,
              x.movies && `+${plural(x.movies, "movie")}`,
              x.created && plural(x.created, "new entry", "new entries"),
              x.updated && `${x.updated} updated`,
              x.ratings && plural(x.ratings, "rating"),
            ].filter(Boolean)
          : [];
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

type Tab = "changes" | "conflicts" | "skipped" | "kept";

const PAGE = 100;

function PreviewResult({
  t,
  preview,
  ignore,
  onIgnore,
  onRestore,
  onClearIgnored,
}: {
  t: Tokens;
  preview: SyncPreview;
  ignore: string[];
  onIgnore: (key: string) => void;
  onRestore: (key: string) => void;
  onClearIgnored: () => void;
}) {
  const [tab, setTab] = useState<Tab>("changes");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<SyncKind | "all">("all");
  const [shown, setShown] = useState(PAGE);
  /** The item just kept out, for the one-click undo. */
  const [undo, setUndo] = useState<{ key: string; title: string } | null>(null);

  const { plan } = preview;
  const kept = new Set(ignore);
  const trackers = preview.reads.filter((r) => r.state === "read").map((r) => r.tracker);
  const match = (title: string, k?: SyncKind) =>
    title.toLowerCase().includes(q.trim().toLowerCase()) && (kind === "all" || k === kind);

  const items = plan.items.filter((i) => !kept.has(i.key) && match(i.title, i.kind));
  const conflicts = plan.conflicts.filter((c) => !kept.has(c.key) && match(c.title));
  const skips = plan.skips.filter((s) => s.reason !== "ignored" && match(s.title));
  // A kept-out item's name: from this plan when it is there, else its key.
  const titles = new Map<string, string>();
  for (const i of plan.items) titles.set(i.key, i.title);
  for (const s of plan.skips) if (s.title) titles.set(s.key, s.title);
  const keptRows = ignore.map((key) => ({ key, title: titles.get(key) ?? key }));

  const keepOut = (item: SyncItem) => {
    onIgnore(item.key);
    setUndo({ key: item.key, title: item.title });
  };

  const tabs: { id: Tab; label: string; n: number }[] = [
    { id: "changes", label: "Changes", n: plan.items.filter((i) => !kept.has(i.key)).length },
    {
      id: "conflicts",
      label: "Trackers disagree",
      n: plan.conflicts.filter((c) => !kept.has(c.key)).length,
    },
    { id: "skipped", label: "Skipped", n: plan.skips.filter((s) => s.reason !== "ignored").length },
    { id: "kept", label: "Kept out", n: ignore.length },
  ];

  return (
    <div class="space-y-4">
      <TrackerCards t={t} reads={preview.reads} preview={preview} />

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
            {tab === "changes" && (
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
      {tab === "changes" && items.length > shown && (
        <Btn t={t} tone="ghost" onClick={() => setShown(shown + PAGE * 5)}>
          Show more ({items.length - shown} left)
        </Btn>
      )}
      {tab === "changes" && !items.length && <Empty t={t} text="Nothing to change." />}

      {tab === "conflicts" && <ConflictTable t={t} trackers={trackers} conflicts={conflicts} />}
      {tab === "conflicts" && !conflicts.length && <Empty t={t} text="Your trackers agree." />}

      {tab === "skipped" && <SkipGroups t={t} skips={skips} />}
      {tab === "skipped" && !skips.length && <Empty t={t} text="Nothing was skipped." />}

      {tab === "kept" && (
        <KeptList t={t} rows={keptRows} onRestore={onRestore} onClearIgnored={onClearIgnored} />
      )}
    </div>
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
    <div class={clsx("overflow-x-auto rounded-lg", t.card)}>
      <table class="w-full text-[12px]">
        <thead>
          <tr class={clsx("border-b text-left", t.divider, t.faint)}>
            <th class="px-3 py-2 font-medium">Title</th>
            {trackers.map((tk) => (
              <th key={tk} class="px-3 py-2 font-medium">
                <span class="flex items-center gap-1.5">
                  <TrackerMark tracker={tk} />
                  {trackerLabel(tk)}
                </span>
              </th>
            ))}
            <th class="w-10" />
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

function conflictValue(c: SyncConflict, v: string | number): string {
  return c.field === "status" ? STATUS_LABEL[v as CourStatus] : `${Math.round(Number(v)) / 10}/10`;
}

function ConflictTable({
  t,
  trackers,
  conflicts,
}: { t: Tokens; trackers: Tracker[]; conflicts: SyncConflict[] }) {
  if (!conflicts.length) return null;
  return (
    <div class="space-y-2">
      <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
        For status, the most recent change wins. Different ratings are left alone until you pick
        one.
      </p>
      <div class={clsx("overflow-x-auto rounded-lg", t.card)}>
        <table class="w-full text-[12px]">
          <thead>
            <tr class={clsx("border-b text-left", t.divider, t.faint)}>
              <th class="px-3 py-2 font-medium">Title</th>
              <th class="px-3 py-2 font-medium">Field</th>
              {trackers.map((tk) => (
                <th key={tk} class="px-3 py-2 font-medium">
                  {trackerLabel(tk)}
                </th>
              ))}
              <th class="px-3 py-2 font-medium">Result</th>
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
                <td class={clsx("px-3 py-2", t.heading)}>
                  {c.chosen ? conflictValue(c, c.chosen.value) : "Left alone"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
