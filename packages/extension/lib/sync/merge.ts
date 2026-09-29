/**
 * Read before write, for the trackers that keep a count (AniList, MAL): the plan
 * was made from a read that may be minutes old, and scrobbling can change an
 * entry in between (docs/ARCHITECTURE.md section 7, "Read before write"). So each write is merged
 * with a fresh read of the entry, by the scrobbling rules:
 *  - progress never goes down: `max(fresh, planned)`.
 *  - a completed entry (or a rewatch) is never moved. Only a higher rewatch count
 *    and an empty rating still go in.
 *  - a status goes in only if the entry still has the status the plan saw. If it
 *    changed, the user (or a scrobble) did that since, and it wins.
 *  - a rating fills an empty one, unless the user picked it in a disagreement.
 *  - a rating the user removed elsewhere (`unrate`) is cleared, if there is one.
 *  - a start or finish day fills an empty one, never changes one, also on a
 *    completed entry (a day is not a move).
 * Pure.
 */
import type { CourStatus } from "../trackers/cour-plan";
import type { Day } from "./read-util";
import type { SyncWrite } from "./types";

/** An entry as it is now on the tracker. `score` is 0 to 100, null = not rated. */
export interface FreshCour {
  status: CourStatus | null;
  progress: number;
  repeat: number;
  score: number | null;
  startedOn?: Day;
  finishedOn?: Day;
}

export type CourAction =
  | {
      kind: "save";
      progress?: number;
      status?: CourStatus;
      repeat?: number;
      score?: number;
      startedOn?: Day;
      finishedOn?: Day;
    }
  | { kind: "delete" }
  | { kind: "none" };

const finished = (s: CourStatus | null | undefined) => s === "COMPLETED" || s === "REPEATING";

/** What to send for one entry: its planned writes (entry, rating, or remove) merged
 * with the entry as it is now (null = not on the list). */
export function mergeCour(writes: SyncWrite[], fresh: FreshCour | null): CourAction {
  if (writes.some((w) => w.op === "remove")) return fresh ? { kind: "delete" } : { kind: "none" };
  const out: Extract<CourAction, { kind: "save" }> = { kind: "save" };
  const entry = writes.find((w) => w.op === "entry");
  const rating = writes.find((w) => w.op === "rating");

  if (entry?.op === "entry") {
    const repeat = entry.repeat?.to;
    if (repeat !== undefined && repeat > (fresh?.repeat ?? 0)) out.repeat = repeat;
    if (!finished(fresh?.status)) {
      const now = fresh?.progress ?? 0;
      const to = Math.max(now, entry.progress?.to ?? 0);
      if (to > now) out.progress = to;
      const status = entry.status?.to;
      if (status && (fresh?.status ?? null) === entry.status?.from && status !== fresh?.status)
        out.status = status;
    }
  }
  // A rating or a day needs an entry: either on an unlisted item would add it.
  const listed = !!fresh || out.progress !== undefined || out.status !== undefined;
  if (entry?.op === "entry" && listed) {
    if (entry.startedOn && !fresh?.startedOn) out.startedOn = entry.startedOn;
    if (entry.finishedOn && !fresh?.finishedOn) out.finishedOn = entry.finishedOn;
  }
  if (rating?.op === "rating" && listed && (rating.picked || !fresh?.score)) {
    if (rating.score !== fresh?.score) out.score = rating.score;
  }
  // A cleared rating is a score of 0 (AniList and MAL both read 0 as "none").
  if (writes.some((w) => w.op === "unrate") && fresh?.score) out.score = 0;
  return Object.keys(out).length > 1 ? out : { kind: "none" };
}
