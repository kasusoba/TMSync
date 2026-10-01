import type { CourStatus } from "../../trackers/cour-plan";
import type { Tracker } from "../../trackers/types";
import { type ScoreScale, onScale } from "../score";
import { pickKey } from "../types";
import type { SyncConflict, SyncPicks, SyncPlan, SyncWrite } from "../types";
import { statusChange } from "./status";

/**
 * The plan with the user's picks in disagreements (keyed by `pickKey`). Pure.
 *
 * A rating pick (0 to 100) replaces the planned rating writes of that item: every
 * tracker that can hold the rating and does not already have the picked score
 * (on its own scale) gets it, its own rating included.
 *
 * A status pick replaces "the most recent wins": every tracker in the
 * disagreement gets the picked status, by the same rules the planner keeps (an
 * entry that sync finishes is completed, "completed" needs every episode, and an
 * entry with progress is not "plan to watch").
 *
 * On a tracker that keeps watches by episode, a status pick is a `status` write
 * of the movie or show, with the same rules (`status.ts`).
 *
 * Without a pick the plan is as planned.
 */
export function withPicks(
  plan: SyncPlan,
  picks: SyncPicks,
  scales: Partial<Record<Tracker, ScoreScale>> = {},
): SyncPlan {
  const scale = (tk: Tracker): ScoreScale => scales[tk] ?? "ten";
  const items = [...plan.items];
  /** Replace an item's writes (adding the item, or dropping it when empty). */
  const setWrites = (c: SyncConflict, edit: (writes: SyncWrite[]) => SyncWrite[]) => {
    const at = items.findIndex((i) => i.key === c.key);
    const found = at >= 0 ? items[at] : undefined;
    const all = edit(found?.writes ?? []);
    const item = { key: c.key, kind: c.kind, title: c.title, year: found?.year, writes: all };
    if (found && all.length) items[at] = item;
    else if (found) items.splice(at, 1);
    else if (all.length) items.push(item);
  };

  const conflicts = plan.conflicts.map((c) => {
    const pick = picks[pickKey(c)];
    if (pick === undefined) return c;
    if (c.field === "rating" && typeof pick === "number" && c.refs) {
      const writes: SyncWrite[] = [];
      for (const { tracker, ...ref } of c.refs) {
        const score = onScale(pick, scale(tracker));
        const cur = c.values.find((v) => v.tracker === tracker)?.value;
        if (typeof cur === "number" && onScale(cur, scale(tracker)) === score) continue;
        writes.push({ tracker, op: "rating", ...ref, score, picked: true });
      }
      setWrites(c, (ws) => [...ws.filter((w) => w.op !== "rating"), ...writes]);
      return { ...c, picked: pick };
    }
    if (c.field === "status" && typeof pick === "string" && c.targets) {
      setWrites(c, (ws) => {
        const out = [...ws];
        for (const t of c.targets ?? []) {
          if (t.shape) {
            // A movie or show on a tracker that keeps watches by episode.
            const shape = t.shape;
            let to: CourStatus | null = pick;
            if (t.progress > 0 && (to === "PLANNING" || shape === "movie"))
              to = shape === "movie" ? null : "CURRENT";
            const status = statusChange(t.tracker, shape, t.status, to);
            const at = out.findIndex((w) => w.tracker === t.tracker && w.op === "status");
            if (at >= 0) out.splice(at, 1);
            if (status) out.push({ tracker: t.tracker, op: "status", target: t.target, status });
            continue;
          }
          let to: CourStatus = pick;
          if (t.total !== null && t.progress >= t.total && t.progress > 0) to = "COMPLETED";
          else if (to === "COMPLETED") to = "CURRENT";
          if (to === "PLANNING" && t.progress > 0) to = "CURRENT";
          const status = to !== t.status ? { from: t.status, to } : undefined;
          const at = out.findIndex((w) => w.tracker === t.tracker && w.op === "entry");
          const w = out[at];
          if (w?.op === "entry") {
            const { status: _planned, ...rest } = w;
            const next: SyncWrite = status ? { ...rest, status } : rest;
            if (status || rest.progress || rest.repeat) out[at] = next;
            else out.splice(at, 1);
          } else if (status) {
            out.push({
              tracker: t.tracker,
              op: "entry",
              target: t.target,
              create: !t.exists,
              status,
            });
          }
        }
        return out;
      });
      return { ...c, picked: pick };
    }
    return c;
  });
  return { ...plan, items, conflicts };
}
