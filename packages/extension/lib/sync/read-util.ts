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

/**
 * When a finished entry was watched: its finish day (a date with no time), at noon
 * UTC so no time zone moves it to another day. Never after `edited` (the entry's
 * last change): the watch came first. Undefined when the day is not a full date.
 */
export function finishedAt(
  day: { year?: number | null; month?: number | null; day?: number | null } | null | undefined,
  edited: number | undefined,
): number | undefined {
  if (!day?.year || !day.month || !day.day) return undefined;
  const t = Date.UTC(day.year, day.month - 1, day.day, 12);
  return edited !== undefined ? Math.min(t, edited) : t;
}

/** The newest of several times. */
export function newest(...t: (number | undefined)[]): number | undefined {
  const known = t.filter((x): x is number => x !== undefined);
  return known.length ? Math.max(...known) : undefined;
}
