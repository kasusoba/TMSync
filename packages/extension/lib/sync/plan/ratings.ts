/** Ratings across trackers: filling empty ones, and the main list's notices. Pure. */
import type { Tracker } from "../../trackers/types";
import { onScale, outOfTen } from "../score";
import type { RatingRef, SyncKind, SyncWrite } from "../types";
import type { PlanContext } from "./context";

/**
 * Fill the empty ratings among `all` (the trackers that can hold this rating;
 * `filled` already have one). All sources must agree on the target's scale;
 * when they do not, it is a conflict and nothing is written. The conflict
 * carries where each tracker keeps the rating, so the user can pick one score
 * for all of them (`withPicks`).
 */
export function fillRatings(
  ctx: PlanContext,
  key: string,
  title: string,
  kind: SyncKind,
  rated: { tracker: Tracker; value: number; at?: number }[],
  all: Tracker[],
  filled: Set<Tracker>,
  where: (tk: Tracker) => RatingRef,
  writes: SyncWrite[],
): void {
  if (!rated.length) return;
  const { scale, conflicts } = ctx;
  let conflicted = false;
  for (const tk of all.filter((x) => !filled.has(x))) {
    const values = new Set(rated.map((r) => onScale(r.value, scale(tk))));
    if (values.size > 1) {
      conflicted = true;
      continue;
    }
    const score = [...values][0] as number;
    const w = where(tk);
    writes.push({
      tracker: tk,
      op: "rating",
      level: w.level,
      season: w.season,
      target: w.target,
      score,
    });
  }
  // Sources that disagree on the 1 to 10 scale are a conflict even when no
  // target is empty; the user may want to line them up.
  const tens = new Set(rated.map((r) => onScale(r.value, "ten")));
  if (conflicted || tens.size > 1) {
    conflicts.push({
      key,
      title,
      kind,
      field: "rating",
      values: [...rated].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
      chosen: null,
      refs: all.map((tk) => ({ tracker: tk, ...where(tk) })),
    });
  }
}

/** A copy's own rating that differs from the main list's is kept, and said so. */
export function ratingNotices(
  ctx: PlanContext,
  key: string,
  title: string,
  kind: SyncKind,
  mainRated: { value: number }[],
  copies: { tracker: Tracker; value: number }[],
): void {
  const { scale, notices } = ctx;
  const m = mainRated[0];
  if (!m) return;
  for (const c of copies) {
    if (onScale(c.value, scale(c.tracker)) !== onScale(m.value, scale(c.tracker))) {
      notices.push({
        key,
        title,
        kind,
        tracker: c.tracker,
        reason: "rating_kept",
        detail: `${outOfTen(c.value)} here, ${outOfTen(m.value)} on the main list`,
      });
    }
  }
}
