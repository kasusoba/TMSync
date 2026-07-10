import type { Tracker } from "@/lib/tracker/types";
import clsx from "clsx";
import { AniListMark, type Tokens, TraktMark } from "./kit";

const TABS: [Tracker, string][] = [
  ["trakt", "Trakt"],
  ["anilist", "AniList"],
];

/**
 * Single-select tracker tab — logo + name, matching the picker's tracker chips
 * (ring = selected). A quick link shows on ONE tracker's pages, so this is a
 * radio, not the picker's multi-toggle. Shared by the popup + Options quick-link
 * editors so the two stay identical.
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
      {TABS.map(([key, label]) => (
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
          {key === "anilist" ? <AniListMark class="size-4" /> : <TraktMark class="size-4" />}
          <span class={clsx("text-[12px] font-medium", t.heading)}>{label}</span>
        </button>
      ))}
    </div>
  );
}
