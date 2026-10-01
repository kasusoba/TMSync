/**
 * Remembered misses (docs/ARCHITECTURE.md section 7). When a tracker answers
 * `not_found` for a write, the item (or the episodes the write sent) is not in
 * its database, often because it numbers the episodes differently (Simkl keeps
 * TVDB order, Trakt and WeTrakr TMDB order). Planned again, the write fails on
 * every run. So the apply remembers it per tracker and item, and the planner
 * leaves it out and lists it as a skip. Some trackers (WeTrakr) take an episode
 * they do not have without a word: so the apply also remembers each episode a
 * tracker took (`sent`), and one that is planned again was not kept. A miss expires after `MISS_TTL_MS`
 * (trackers add titles and episodes), and connecting the account again
 * forgets the tracker's misses. Pure, except the storage helpers at the end.
 */
import { listSyncMisses } from "../storage";
import type { Tracker } from "../trackers/types";
import type { EpisodeRef, SyncSkip, SyncWrite } from "./types";

export const MISS_TTL_MS = 30 * 24 * 60 * 60_000;

/** One item a tracker could not match: all of it (`whole`), or some episodes
 * (`eps`, as `epKey`). `at` = when it was last missed (ms). */
export interface Miss {
  at: number;
  whole?: true;
  eps?: string[];
  /** Episodes the tracker took. Planned again, they were not kept: a miss. */
  sent?: string[];
}

/** Each tracker's misses, by item key (`SyncItem.key`). */
export type SyncMisses = Partial<Record<Tracker, Record<string, Miss>>>;

export const epKey = (e: EpisodeRef) => `${e.season ?? ""}:${e.number}`;

/** The misses with the new ones added. An episodes write adds its episodes;
 * any other write marks the whole item. `taken` = episodes writes the tracker
 * answered as done, kept as `sent`. Pure. */
export function addMisses(
  old: SyncMisses,
  found: { key: string; w: SyncWrite }[],
  now: number,
  taken: { key: string; w: SyncWrite }[] = [],
): SyncMisses {
  const out: SyncMisses = { ...old };
  const edit = (key: string, w: SyncWrite, change: (m: Miss) => void) => {
    const mine = { ...out[w.tracker] };
    const m: Miss = { ...mine[key], at: now };
    change(m);
    mine[key] = m;
    out[w.tracker] = mine;
  };
  for (const { key, w } of found)
    edit(key, w, (m) => {
      if (w.op === "episodes") m.eps = [...new Set([...(m.eps ?? []), ...w.add.map(epKey)])];
      else m.whole = true;
    });
  for (const { key, w } of taken)
    if (w.op === "episodes")
      edit(key, w, (m) => {
        m.sent = [...new Set([...(m.sent ?? []), ...w.add.map(epKey)])];
      });
  return out;
}

/** The misses that have not expired. Pure. */
export function liveMisses(m: SyncMisses, now: number): SyncMisses {
  const out: SyncMisses = {};
  for (const [tk, items] of Object.entries(m) as [Tracker, Record<string, Miss>][]) {
    const kept = Object.entries(items ?? {}).filter(([, v]) => now - v.at < MISS_TTL_MS);
    if (kept.length) out[tk] = Object.fromEntries(kept);
  }
  return out;
}

/**
 * One item's writes without what its trackers missed before, and a skip for
 * each tracker that lost a write or some episodes. A whole miss drops every write
 * to that tracker, so the item never half applies. Pure.
 */
export function dropMissed(
  key: string,
  title: string,
  writes: SyncWrite[],
  misses: SyncMisses | undefined,
): { writes: SyncWrite[]; skips: SyncSkip[] } {
  if (!misses) return { writes, skips: [] };
  const kept: SyncWrite[] = [];
  const lost = new Map<Tracker, number>();
  const whole = new Set<Tracker>();
  for (const w of writes) {
    const m = misses[w.tracker]?.[key];
    if (!m) {
      kept.push(w);
      continue;
    }
    if (m.whole) {
      whole.add(w.tracker);
      continue;
    }
    if (w.op === "episodes" && (m.eps?.length || m.sent?.length)) {
      const gone = new Set([...(m.eps ?? []), ...(m.sent ?? [])]);
      const add = w.add.filter((e) => !gone.has(epKey(e)));
      const n = w.add.length - add.length;
      if (n) lost.set(w.tracker, (lost.get(w.tracker) ?? 0) + n);
      if (add.length) kept.push({ ...w, add });
      continue;
    }
    kept.push(w);
  }
  const skips: SyncSkip[] = [
    ...[...whole].map((tracker) => ({ key, title, tracker, reason: "not_on_tracker" as const })),
    ...[...lost].map(([tracker, n]) => ({
      key,
      title,
      tracker,
      reason: "not_on_tracker" as const,
      detail: `${n} episode${n === 1 ? "" : "s"}`,
    })),
  ];
  return { writes: kept, skips };
}

// The trackers of one apply run side by side: one save at a time, so none is lost.
let saving = Promise.resolve();

/** Save the writes a tracker could not match. Never throws: a lost miss only
 * means the write is tried again. */
export function rememberMisses(
  found: { key: string; w: SyncWrite }[],
  taken: { key: string; w: SyncWrite }[] = [],
): Promise<void> {
  if (!found.length && !taken.some((x) => x.w.op === "episodes")) return saving;
  saving = saving
    .then(async () => {
      const now = Date.now();
      const old = await listSyncMisses.getValue();
      await listSyncMisses.setValue(addMisses(liveMisses(old, now), found, now, taken));
    })
    .catch(() => {});
  return saving;
}

/** Forget one tracker's misses (its account was connected or disconnected). */
export async function forgetMisses(tracker: Tracker): Promise<void> {
  await listSyncMisses
    .getValue()
    .then(({ [tracker]: _gone, ...rest }) => listSyncMisses.setValue(rest))
    .catch(() => {});
}
