/**
 * The List sync pane (docs/ARCHITECTURE.md section 7), presentational: the options page and the
 * gallery feed it. A preview shows what each tracker is missing; Apply writes it,
 * after a confirm that says what will be removed first.
 *
 * Built for a wide pane: the changes are a table with one column per tracker, so a
 * long plan reads row by row. Tabs split changes, disagreements, skips, and the
 * items the user keeps out (which can be brought back from there).
 */
import type { ApplyBlock, ApplyJob } from "@/lib/sync/apply";
import type { AutoRun } from "@/lib/sync/auto";
import type { SyncPreview, TrackerRead } from "@/lib/sync/preview";
import {
  type ListSyncSettings,
  type SyncKind,
  type SyncPick,
  type SyncPicks,
  pickKey,
} from "@/lib/sync/types";
import { type Tracker, trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
import { Btn, Icon, Switch, type Tokens, TrackerMark } from "../kit";
import { PreviewResult } from "./PreviewResult";
import { AutoLine, CardTitle, SettingRow, TrackerCards } from "./cards";
import { KINDS, KIND_LABEL } from "./labels";

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
