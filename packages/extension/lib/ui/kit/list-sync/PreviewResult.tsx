/** A finished preview: the totals and the tabs (changes, removals, notices,
 * conflicts, skips, kept out). */
import type { ApplyBlock, ApplyJob } from "@/lib/sync/apply";
import { summarize, withPicks } from "@/lib/sync/plan/index";
import type { SyncPreview } from "@/lib/sync/preview";
import type { SyncItem, SyncKind, SyncPick, SyncPicks } from "@/lib/sync/types";
import clsx from "clsx";
import { useState } from "preact/hooks";
import { Btn, Icon, type Tokens } from "../kit";
import { ApplyBar } from "./ApplyBar";
import { ApplyProgress } from "./ApplyProgress";
import { ChangesTable, Empty, ShowMore } from "./ChangesTable";
import { TrackerCards } from "./cards";
import { KINDS, KIND_LABEL } from "./labels";
import { ConflictTable, KeptList, NoticeTable, SkipGroups } from "./tables";

type Tab = "changes" | "removals" | "notices" | "conflicts" | "skipped" | "kept";

const isRemoval = (i: SyncItem) => i.writes.every((w) => w.op === "remove" || w.op === "unrate");

const PAGE = 100;

export function PreviewResult({
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
