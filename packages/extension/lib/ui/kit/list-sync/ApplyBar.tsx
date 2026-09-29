/** The bar under a preview: what applying will do, and the Apply button or why it is blocked. */
import type { ApplyBlock } from "@/lib/sync/apply";
import type { SyncPlan, SyncTotals } from "@/lib/sync/types";
import { trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
import { useState } from "preact/hooks";
import { Btn, type Tokens, TrackerMark } from "../kit";
import { plural, totalParts } from "./labels";

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
export function ApplyBar({
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
