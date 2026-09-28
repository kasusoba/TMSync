/** Small helpers the per-tracker writers share (plans/list-sync.md, phase 2). */
import type { SyncWrite, TargetRef, WriteOutcome } from "./types";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A stable key for a write's target, so one entry's writes go out together. Pure. */
export function targetKey(t: TargetRef): string {
  return t.id !== undefined ? `id:${t.id}` : JSON.stringify(t.ids);
}

/** The writes grouped by target, each with its place in the chunk. Pure. */
export function byTarget(writes: SyncWrite[]): { target: TargetRef; at: number[] }[] {
  const groups = new Map<string, { target: TargetRef; at: number[] }>();
  writes.forEach((w, i) => {
    const k = targetKey(w.target);
    const g = groups.get(k);
    if (g) g.at.push(i);
    else groups.set(k, { target: w.target, at: [i] });
  });
  return [...groups.values()];
}

/** A 0 to 100 score as a whole 1 to 10 (Trakt, MAL, Simkl). Pure. */
export function toTen(score: number): number {
  return Math.min(10, Math.max(1, Math.round(score / 10)));
}

/** Results for a chunk, all the same until set one by one. */
export function outcomes(n: number, fill: WriteOutcome): WriteOutcome[] {
  return Array.from({ length: n }, () => ({ ...fill }));
}

/**
 * Whether a tracker's `not_found` reply names this item. Trakt and Simkl echo the
 * items they could not match as they were sent, so an echo is ours when every id
 * it carries equals ours (as strings: Simkl sends ids back as strings). Pure.
 */
export function inNotFound(data: unknown, ids: Record<string, string | number>): boolean {
  const nf = (data as { not_found?: Record<string, unknown> } | undefined)?.not_found;
  if (!nf || typeof nf !== "object") return false;
  return Object.values(nf).some(
    (list) =>
      Array.isArray(list) &&
      list.some((x) => {
        const echo = (x as { ids?: Record<string, unknown> } | null)?.ids;
        const keys = echo ? Object.keys(echo) : [];
        return keys.length > 0 && keys.every((k) => String(echo?.[k]) === String(ids[k]));
      }),
  );
}
