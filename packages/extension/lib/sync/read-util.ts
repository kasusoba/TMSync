/** Small pure helpers the list readers share. */
import type { z } from "zod";

/** An ISO date as ms, or undefined. */
export function ms(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** A number from a string or number id, or undefined. */
export function num(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parse each item on its own and keep the ones that fit. A bad item is dropped,
 * never half-read (the same rule as recipes, constraint #8). */
export function parseEach<S extends z.ZodTypeAny>(schema: S, items: unknown[]): z.output<S>[] {
  const out: z.output<S>[] = [];
  for (const it of items) {
    const r = schema.safeParse(it);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** A date with no time, `2024-03-09`: how AniList and MAL keep start and finish days. */
export type Day = string;

/** A full date from its parts (AniList's `FuzzyDate`), or undefined when a part is
 * missing. Pure. */
export function dayOf(
  d: { year?: number | null; month?: number | null; day?: number | null } | null | undefined,
): Day | undefined {
  if (!d?.year || !d.month || !d.day) return undefined;
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** A MAL date (`2024-03-09`, or only `2024-03` or `2024`) as a full day, or
 * undefined when it is not one. Pure. */
export function fullDay(v: string | null | undefined): Day | undefined {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

/** A day as its parts (AniList's `FuzzyDateInput`). Pure. */
export function dayParts(d: Day): { year: number; month: number; day: number } {
  const [year, month, day] = d.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

/**
 * When a finished entry was watched: its finish day, at noon UTC so no time zone
 * moves it to another day. Never after `edited` (the entry's last change): the
 * watch came first. Undefined with no finish day.
 */
export function finishedAt(day: Day | undefined, edited: number | undefined): number | undefined {
  if (!day) return undefined;
  const { year, month, day: d } = dayParts(day);
  const t = Date.UTC(year, month - 1, d, 12);
  return edited !== undefined ? Math.min(t, edited) : t;
}

/** The newest of several times. */
export function newest(...t: (number | undefined)[]): number | undefined {
  const known = t.filter((x): x is number => x !== undefined);
  return known.length ? Math.max(...known) : undefined;
}
