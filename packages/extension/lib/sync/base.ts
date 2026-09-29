/**
 * The list sync base (docs/ARCHITECTURE.md section 7, "The base"): what each tracker's list
 * held after the last sync. With it, union mode can tell "removed on one
 * list" (in the base, gone now) from "never there" (not in the base), and remove
 * the entry (or the rating) from the others instead of adding it back.
 *
 * The base keeps only what that needs: each entry's id keys, and whether it was
 * rated. So it stays small even for a big Trakt library. It moves after every
 * apply, with only the writes that were taken laid over. An item with a write that
 * was not taken (it failed, was left out, or was held back) keeps its entries from
 * the old base (`keepOpen`): read as it is now, a failed removal would look like
 * "never there" and be added back. It is dropped when the sync settings change
 * (`settingsSig`) or an account is connected or disconnected.
 *
 * A removal can leave a copy that sync never deletes (Trakt watch history). Then
 * the lists that removed the item keep a REMOVED mark for it (`x`), so the next
 * sync still reads it as removed there and does not add it back from that copy.
 * The mark goes when the user adds the item to that list again.
 */
import { type Tracker, trackerFamily } from "../trackers/types";
import type {
  ListEntry,
  ListSyncSettings,
  SyncIds,
  SyncItem,
  SyncPlan,
  SyncWrite,
  TargetRef,
} from "./types";

/** Bump when the saved shape changes: an older base is then ignored. */
export const BASE_VERSION = 2;

/** One entry of a tracker's list at the base: its id keys (`anilist:1`,
 * `tv:tmdb:1399`, ...), whether it was rated (`r`), and its rated seasons (`s`,
 * Trakt only). `o` = only ratings: the list has the item because it is rated, and
 * nothing of it is watched (Trakt makes an entry from a rating alone). Then the entry
 * goes away when the rating does, which is an unrate, not a removal. `x` = a removed
 * mark: the user removed the item from this list, and another list keeps a copy sync
 * never deletes. */
export interface BaseEntry {
  k: string[];
  r?: 1;
  s?: number[];
  o?: 1;
  x?: 1;
}

export interface SyncBase {
  v: number;
  /** When it was taken (ms). */
  at: number;
  /** The settings it was taken under (`settingsSig`). */
  sig: string;
  trackers: Partial<Record<Tracker, BaseEntry[]>>;
}

/** The lists of a preview, kept until its apply says whether they became the
 * base. `planAt` is the preview's `at`; `readAt` is when its reads started. */
export interface PendingBase {
  v: number;
  planAt: number;
  readAt: number;
  sig: string;
  trackers: Partial<Record<Tracker, BaseEntry[]>>;
}

/** The id keys of a set of ids. `kind` names the id space of tmdb, imdb, and
 * tvdb ids (a movie and a show can share a tmdb number). Pure. */
export function idKeys(ids: SyncIds, kind: "movie" | "tv"): string[] {
  const out: string[] = [];
  if (ids.anilist !== undefined) out.push(`anilist:${ids.anilist}`);
  if (ids.mal !== undefined) out.push(`mal:${ids.mal}`);
  if (ids.tmdb !== undefined) out.push(`${kind}:tmdb:${ids.tmdb}`);
  if (ids.imdb) out.push(`${kind}:imdb:${ids.imdb}`);
  if (ids.tvdb !== undefined) out.push(`${kind}:tvdb:${ids.tvdb}`);
  return out;
}

/** An entry's id keys. A cour entry is known by its AniList and MAL ids only. Pure. */
export function entryKeys(e: ListEntry): string[] {
  if (e.shape === "cour") return idKeys({ anilist: e.ids.anilist, mal: e.ids.mal }, "tv");
  return idKeys(e.ids, e.shape === "movie" ? "movie" : "tv");
}

/** A write target's id keys. Pure. */
export function refKeys(t: TargetRef): string[] {
  return idKeys(t.ids, t.mediaType === "movie" ? "movie" : "tv");
}

/** Whether a tracker's list holds only watch history (Trakt): an entry there with
 * nothing watched is there only for its ratings. Pure. */
const historyOnly = (tk: Tracker) => trackerFamily(tk) === "seasoned";

/** Whether an entry holds nothing but ratings (see `BaseEntry.o`). Pure. */
function ratingsOnly(e: ListEntry): boolean {
  if (!historyOnly(e.tracker)) return false;
  if (e.shape === "movie") return !e.watched;
  if (e.shape === "seasons") return Object.values(e.seasons).every((eps) => !eps.length);
  return false;
}

/** A tracker's list as base entries. Pure. */
export function baseOf(entries: ListEntry[]): BaseEntry[] {
  return entries.map((e) => {
    const b: BaseEntry = { k: entryKeys(e) };
    if (e.rating !== null) b.r = 1;
    if (e.shape === "seasons" && e.seasonRatings) {
      const s = Object.keys(e.seasonRatings).map(Number);
      if (s.length) b.s = s;
    }
    if (ratingsOnly(e)) b.o = 1;
    return b;
  });
}

/** The lists a preview read, as the next base: each tracker's entries, plus the
 * plan's removed marks for it. Pure. */
export function nextLists(
  entries: ListEntry[],
  trackers: Tracker[],
  removed: SyncPlan["removed"] = [],
): Partial<Record<Tracker, BaseEntry[]>> {
  return Object.fromEntries(
    trackers.map((tk) => [
      tk,
      [
        ...baseOf(entries.filter((e) => e.tracker === tk)),
        ...removed.filter((r) => r.tracker === tk).map((r) => ({ k: r.keys, x: 1 as const })),
      ],
    ]),
  );
}

/** What of the settings changes the meaning of a base. Anything else (the ignore
 * list, auto sync) does not. Pure. */
export function settingsSig(s: ListSyncSettings): string {
  const kinds = Object.entries(s.kinds)
    .map(([tk, ks]) => [tk, [...(ks ?? [])].sort()] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const main = Object.entries(s.main ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([kinds, main, s.includePrivate, s.includeAdult]);
}

/** Find a tracker's base entry by any of its id keys. An entry wins over a
 * removed mark with the same key. */
export class BaseIndex {
  private byKey = new Map<string, BaseEntry>();
  constructor(entries: BaseEntry[]) {
    for (const e of entries)
      for (const k of e.k) if (!this.byKey.get(k) || this.byKey.get(k)?.x) this.byKey.set(k, e);
  }
  find(keys: string[]): BaseEntry | undefined {
    for (const k of keys) {
      const hit = this.byKey.get(k);
      if (hit) return hit;
    }
    return undefined;
  }
}

/**
 * The lists after an apply: the lists as read, with the applied writes laid over.
 * A write that adds makes (or marks rated) the entry and clears a removed mark,
 * a removal drops the entry, an unrate clears its rating. A rating alone makes an
 * only-ratings entry on a history list, a watch makes it a real one, and an unrate
 * of its last rating drops it (as the tracker does). This is what the lists hold
 * once every write is taken, without reading them again. Pure.
 */
export function afterWrites(
  lists: Partial<Record<Tracker, BaseEntry[]>>,
  writes: SyncWrite[],
): Partial<Record<Tracker, BaseEntry[]>> {
  const out: Partial<Record<Tracker, BaseEntry[]>> = {};
  for (const [tk, entries] of Object.entries(lists) as [Tracker, BaseEntry[]][])
    out[tk] = entries.map((e) => ({ ...e, k: [...e.k], ...(e.s ? { s: [...e.s] } : {}) }));
  for (const w of writes) {
    const list = out[w.tracker];
    if (!list) continue;
    const keys = refKeys(w.target);
    const at = list.findIndex((e) => !e.x && e.k.some((k) => keys.includes(k)));
    if (w.op === "remove") {
      if (at >= 0) list.splice(at, 1);
      continue;
    }
    // The item is on this list again: it is no longer removed here.
    for (let i = list.length - 1; i >= 0; i -= 1)
      if (list[i]?.x && list[i]?.k.some((k) => keys.includes(k))) list.splice(i, 1);
    let e = list[at];
    if (!e) {
      e = { k: keys };
      if ((w.op === "rating" || w.op === "unrate") && historyOnly(w.tracker)) e.o = 1;
      list.push(e);
    } else {
      for (const k of keys) if (!e.k.includes(k)) e.k.push(k);
    }
    if (w.op === "movie" || w.op === "episodes") e.o = undefined;
    if (w.op === "rating") {
      if (w.level === "season" && w.season !== undefined)
        e.s = [...new Set([...(e.s ?? []), w.season])];
      else e.r = 1;
    } else if (w.op === "unrate") {
      if (w.level === "season") {
        e.s = (e.s ?? []).filter((n) => n !== w.season);
        if (!e.s.length) e.s = undefined;
      } else e.r = undefined;
      if (e.o && !e.r && !e.s) list.splice(list.indexOf(e), 1);
    }
  }
  return out;
}

/**
 * The lists after an apply, with each OPEN item (one with a write that was not
 * taken) put back as the old base had it, on every list. So the next sync sees it
 * as this one did: a removal that did not go through is still a removal, and an
 * add that did not go through is added again. An item is found by its key, its
 * writes' ids, and the ids of every entry that shares one of those. Pure.
 */
export function keepOpen(
  lists: Partial<Record<Tracker, BaseEntry[]>>,
  old: Partial<Record<Tracker, BaseEntry[]>>,
  open: SyncItem[],
): Partial<Record<Tracker, BaseEntry[]>> {
  if (!open.length) return lists;
  const seed = new Set(open.flatMap((i) => [i.key, ...i.writes.flatMap((w) => refKeys(w.target))]));
  const keys = new Set(seed);
  for (const src of [lists, old])
    for (const list of Object.values(src))
      for (const e of list ?? [])
        if (e.k.some((k) => seed.has(k))) for (const k of e.k) keys.add(k);
  const touches = (e: BaseEntry) => e.k.some((k) => keys.has(k));
  const out: Partial<Record<Tracker, BaseEntry[]>> = {};
  for (const [tk, list] of Object.entries(lists) as [Tracker, BaseEntry[]][])
    out[tk] = [...list.filter((e) => !touches(e)), ...(old[tk] ?? []).filter(touches)];
  return out;
}
