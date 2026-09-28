/**
 * The List sync pane (plans/list-sync.md), presentational: the options page and the
 * gallery feed it. Phase 1 previews only: it shows what each tracker is missing,
 * and nothing is written.
 */
import type { SyncPreview, TrackerRead } from "@/lib/sync/run";
import type { ListSyncSettings, SkipReason, SyncItem, SyncKind, SyncWrite } from "@/lib/sync/types";
import type { CourStatus } from "@/lib/trackers/cour-plan";
import { type Tracker, trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
import { useState } from "preact/hooks";
import { Btn, Icon, IconBtn, Switch, type Tokens, TrackerMark } from "./kit";

const KIND_LABEL: Record<SyncKind, string> = { movie: "Movies", tv: "TV", anime: "Anime" };

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
  busy,
  error,
  onPreview,
  onKind,
  onSetting,
  onIgnore,
  onClearIgnored,
}: {
  t: Tokens;
  rows: KindRow[];
  settings: ListSyncSettings;
  preview: SyncPreview | null;
  busy: boolean;
  error?: string;
  onPreview: () => void;
  onKind: (tracker: Tracker, kind: SyncKind, on: boolean) => void;
  onSetting: (key: "includePrivate" | "includeAdult", on: boolean) => void;
  onIgnore: (key: string) => void;
  onClearIgnored: () => void;
}) {
  return (
    <div class="space-y-4">
      <p class={clsx("text-[12px] leading-relaxed", t.sub)}>
        Make your trackers agree. TMSync reads each connected list and works out what the others are
        missing: watched episodes, list status, and ratings. It only adds, it never removes. This
        version shows the plan only. Nothing is written to your trackers yet.
      </p>

      <section class="space-y-2">
        <h3 class={clsx("text-[11px] font-semibold uppercase tracking-wider", t.faint)}>
          What each tracker syncs
        </h3>
        {rows.map((r) => (
          <div
            key={r.tracker}
            class={clsx("flex items-center gap-3 rounded-lg px-3 py-2.5", t.card)}
          >
            <TrackerMark tracker={r.tracker} />
            <span class={clsx("min-w-0 flex-1 text-[13px] font-semibold", t.heading)}>
              {trackerLabel(r.tracker)}
            </span>
            {r.can.map((k) => (
              <span key={k} class={clsx("flex items-center gap-1.5 text-[12px]", t.sub)}>
                {KIND_LABEL[k]}
                <Switch
                  t={t}
                  on={r.on.includes(k)}
                  onClick={() => onKind(r.tracker, k, !r.on.includes(k))}
                />
              </span>
            ))}
          </div>
        ))}
        <div class={clsx("space-y-2 rounded-lg px-3 py-2.5", t.card)}>
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
        </div>
        {settings.ignore.length > 0 && (
          <div class="flex items-center justify-between gap-3">
            <span class={clsx("text-[12px]", t.sub)}>
              {plural(settings.ignore.length, "item")} kept out of sync.
            </span>
            <Btn t={t} tone="ghost" onClick={onClearIgnored}>
              Sync them again
            </Btn>
          </div>
        )}
      </section>

      <div class="flex items-center gap-3">
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

      {error && <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.badBox)}>{error}</p>}
      {preview && <PreviewResult t={t} preview={preview} onIgnore={onIgnore} />}
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

const SHOW_ITEMS = 50;

function PreviewResult({
  t,
  preview,
  onIgnore,
}: { t: Tokens; preview: SyncPreview; onIgnore: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const { plan } = preview;
  const skipsByReason = new Map<SkipReason, number>();
  for (const s of plan.skips) skipsByReason.set(s.reason, (skipsByReason.get(s.reason) ?? 0) + 1);
  const items = all ? plan.items : plan.items.slice(0, SHOW_ITEMS);

  return (
    <div class="space-y-4">
      <section class="space-y-2">
        <h3 class={clsx("text-[11px] font-semibold uppercase tracking-wider", t.faint)}>Lists</h3>
        <div class={clsx("divide-y rounded-lg", t.card, t.divider)}>
          {preview.reads.map((r) => (
            <div
              key={r.tracker}
              class={clsx("flex items-center gap-3 px-3 py-2 text-[12px]", t.divider)}
            >
              <TrackerMark tracker={r.tracker} />
              <span class={clsx("flex-1", t.heading)}>{trackerLabel(r.tracker)}</span>
              <span class={t.sub}>
                {r.state === "read"
                  ? plural(r.count ?? 0, "entry", "entries")
                  : READ_LABEL[r.state]}
                {r.error ? ` · ${r.error}` : ""}
              </span>
            </div>
          ))}
        </div>
        {preview.noCrosswalk && (
          <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
            The anime crosswalk isn’t downloaded yet, so anime can’t move between Trakt and AniList
            or MyAnimeList. Refresh the library and preview again.
          </p>
        )}
        {preview.reason === "too_few" && (
          <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
            Sync needs at least two trackers. Connect another in Account, or turn one on above.
          </p>
        )}
      </section>

      {preview.totals.length > 0 && (
        <section class="space-y-2">
          <h3 class={clsx("text-[11px] font-semibold uppercase tracking-wider", t.faint)}>
            What would change
          </h3>
          <div class={clsx("divide-y rounded-lg", t.card, t.divider)}>
            {preview.totals.map((x) => {
              const parts = [
                x.episodes && `+${plural(x.episodes, "episode")}`,
                x.movies && `+${plural(x.movies, "movie")}`,
                x.created && plural(x.created, "new entry", "new entries"),
                x.updated && `${x.updated} updated`,
                x.ratings && `${plural(x.ratings, "rating")}`,
              ].filter(Boolean);
              return (
                <div
                  key={x.tracker}
                  class={clsx("flex items-center gap-3 px-3 py-2 text-[12px]", t.divider)}
                >
                  <TrackerMark tracker={x.tracker} />
                  <span class={clsx("flex-1", t.heading)}>{trackerLabel(x.tracker)}</span>
                  <span class={t.sub}>{parts.length ? parts.join(" · ") : "Nothing to add"}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {plan.conflicts.length > 0 && (
        <section class="space-y-2">
          <h3 class={clsx("text-[11px] font-semibold uppercase tracking-wider", t.faint)}>
            Trackers disagree ({plan.conflicts.length})
          </h3>
          <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
            For status, the most recent change wins. Different ratings are left alone until you pick
            one.
          </p>
          <div class={clsx("divide-y rounded-lg", t.card, t.divider)}>
            {plan.conflicts.slice(0, all ? undefined : SHOW_ITEMS).map((c) => (
              <div key={`${c.key}:${c.field}`} class={clsx("px-3 py-2 text-[12px]", t.divider)}>
                <span class={clsx("block", t.heading)}>{c.title}</span>
                <span class={clsx("block", t.sub)}>
                  {c.values
                    .map(
                      (v) =>
                        `${trackerLabel(v.tracker)}: ${
                          c.field === "status"
                            ? STATUS_LABEL[v.value as CourStatus]
                            : `${Math.round(Number(v.value)) / 10}/10`
                        }`,
                    )
                    .join(" · ")}
                  {c.chosen ? ` → ${STATUS_LABEL[c.chosen.value as CourStatus]}` : " → left alone"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {plan.items.length > 0 && (
        <section class="space-y-2">
          <h3 class={clsx("text-[11px] font-semibold uppercase tracking-wider", t.faint)}>
            Items ({plan.items.length})
          </h3>
          <div class={clsx("divide-y rounded-lg", t.card, t.divider)}>
            {items.map((item) => (
              <ItemRow key={item.key} t={t} item={item} onIgnore={onIgnore} />
            ))}
          </div>
          {plan.items.length > SHOW_ITEMS && (
            <Btn t={t} tone="ghost" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${plan.items.length}`}
            </Btn>
          )}
        </section>
      )}

      {skipsByReason.size > 0 && (
        <section class="space-y-2">
          <h3 class={clsx("text-[11px] font-semibold uppercase tracking-wider", t.faint)}>
            Skipped
          </h3>
          <div class={clsx("divide-y rounded-lg", t.card, t.divider)}>
            {[...skipsByReason].map(([reason, n]) => (
              <SkipGroup key={reason} t={t} reason={reason} count={n} preview={preview} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ItemRow({
  t,
  item,
  onIgnore,
}: { t: Tokens; item: SyncItem; onIgnore: (key: string) => void }) {
  return (
    <div class={clsx("flex items-start gap-3 px-3 py-2 text-[12px]", t.divider)}>
      <span class="min-w-0 flex-1">
        <span class={clsx("block truncate", t.heading)}>
          {item.title}
          {item.year ? ` (${item.year})` : ""}
          <span class={clsx("ml-2 rounded px-1 py-0.5 text-[10px]", t.chip)}>
            {KIND_LABEL[item.kind]}
          </span>
        </span>
        {item.writes.map((w) => (
          <span key={`${w.tracker}:${w.op}`} class={clsx("block", t.sub)}>
            {trackerLabel(w.tracker)}: {describeWrite(w)}
          </span>
        ))}
      </span>
      <IconBtn
        t={t}
        name="eye-off"
        title="Keep this item out of sync"
        onClick={() => onIgnore(item.key)}
      />
    </div>
  );
}

function SkipGroup({
  t,
  reason,
  count,
  preview,
}: { t: Tokens; reason: SkipReason; count: number; preview: SyncPreview }) {
  const [open, setOpen] = useState(false);
  const skips = preview.plan.skips.filter((s) => s.reason === reason);
  return (
    <div class={clsx("px-3 py-2 text-[12px]", t.divider)}>
      <button
        type="button"
        class="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? "down" : "chevron"} class={clsx("text-[12px]", t.faint)} />
        <span class={clsx("flex-1", t.heading)}>{SKIP_LABEL[reason]}</span>
        <span class={t.sub}>{count}</span>
      </button>
      {open && (
        <ul class="mt-1.5 space-y-0.5 pl-5">
          {skips.slice(0, 200).map((s) => (
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
