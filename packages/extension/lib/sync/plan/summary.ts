import type { Tracker } from "../../trackers/types";
import type { SyncPlan, SyncTotals } from "../types";

/** Per-tracker totals for the preview. Pure. */
export function summarize(plan: SyncPlan, trackers: Tracker[]): SyncTotals[] {
  const totals = new Map<Tracker, SyncTotals>(
    trackers.map((tk) => [
      tk,
      {
        tracker: tk,
        episodes: 0,
        movies: 0,
        created: 0,
        updated: 0,
        ratings: 0,
        removed: 0,
        unrated: 0,
      },
    ]),
  );
  for (const item of plan.items) {
    for (const w of item.writes) {
      const t = totals.get(w.tracker);
      if (!t) continue;
      if (w.op === "episodes") t.episodes += w.add.length;
      else if (w.op === "movie") t.movies += 1;
      else if (w.op === "rating") t.ratings += 1;
      else if (w.op === "remove") t.removed += 1;
      else if (w.op === "unrate") t.unrated += 1;
      else if (w.create) t.created += 1;
      else t.updated += 1;
    }
  }
  return [...totals.values()];
}
