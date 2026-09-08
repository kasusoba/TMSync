/**
 * Loading half of the anime-map crosswalk: validate a fetched payload, and hand
 * the background a ready `Animap` built from the cached copy.
 *
 * The rows are NOT bundled (they are ~300 KB, fetched from the CDN like the recipe
 * list), so every lookup path has to cope with "not downloaded yet": that state is
 * an EMPTY map, which misses on everything, so a derived tracker degrades to
 * native-only exactly as an unmapped title does.
 */
import { z } from "zod";
import { animeMap } from "../storage";
import { Animap, type AnimapRow, EMPTY_ANIMAP } from "./index";

/** One row of the CDN payload. Unknown/extra fields are dropped, bad rows are
 *  discarded individually. A malformed list must never land half-applied
 *  (constraint #8). */
const Row = z.object({
  a: z.number().int(),
  t: z.number().int(),
  k: z.enum(["tv", "movie"]),
  s: z.number().int().nullish(),
  o: z.number().int().nullish(),
});

const Payload = z.object({
  version: z.number().int().optional(),
  generatedAt: z.string().optional(),
  rows: z.array(z.unknown()),
});

/** Validate a fetched anime-map document. Throws when the shape is wrong; drops
 *  individual rows that don't parse. */
export function parseAnimeMap(raw: unknown): { rows: AnimapRow[]; generatedAt?: string } {
  const doc = Payload.parse(raw);
  const rows: AnimapRow[] = [];
  for (const r of doc.rows) {
    const parsed = Row.safeParse(r);
    if (parsed.success) rows.push(parsed.data);
  }
  return { rows, generatedAt: doc.generatedAt };
}

/**
 * The crosswalk built from the cached rows. Memoized per service-worker wake and
 * keyed on the cache's `fetchedAt`, so a refresh mid-wake rebuilds it. This is a
 * derived cache of a storage value, not session state. The worker still holds
 * nothing that isn't re-readable from storage (constraint #4).
 */
let cached: { fetchedAt: number; map: Animap } | null = null;

export async function loadAnimap(): Promise<Animap> {
  const entry = await animeMap.getValue();
  if (!entry) return EMPTY_ANIMAP;
  if (cached?.fetchedAt === entry.fetchedAt) return cached.map;
  const map = new Animap(entry.rows);
  cached = { fetchedAt: entry.fetchedAt, map };
  return map;
}
