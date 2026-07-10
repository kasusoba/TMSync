import { ALL_TRACKERS, type Tracker, trackerLabel } from "@/lib/tracker/types";
import clsx from "clsx";
import { type Tokens, TrackerMark } from "./kit";

/**
 * Single-select tracker tab — logo + name, matching the picker's tracker chips
 * (ring = selected). A quick link shows on ONE tracker's pages, so this is a
 * radio, not the picker's multi-toggle. Shared by the popup + Options quick-link
 * editors so the two stay identical. Iterates ALL_TRACKERS, so a new tracker shows
 * up here automatically.
 */
export function TrackerTab({
  t,
  value,
  onChange,
}: {
  t: Tokens;
  value: Tracker;
  onChange?: (tracker: Tracker) => void;
}) {
  return (
    <div class="flex gap-1.5">
      {ALL_TRACKERS.map((key) => (
        <button
          type="button"
          key={key}
          onClick={() => onChange?.(key)}
          class={clsx(
            "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 ring-inset transition",
            t.card,
            value === key ? "ring-2 ring-ikura" : "ring-1 ring-transparent",
          )}
        >
          <TrackerMark tracker={key} class="size-4" />
          <span class={clsx("text-[12px] font-medium", t.heading)}>{trackerLabel(key)}</span>
        </button>
      ))}
    </div>
  );
}
