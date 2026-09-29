/**
 * The list sync base (plans/list-sync-phase3.md, phase 3): what each tracker's list
 * held after the last CLEAN sync. With it, union mode can tell "removed on one
 * list" (in the base, gone now) from "never there" (not in the base), and remove
 * the entry (or the rating) from the others instead of adding it back.
 *
 * The base keeps only what that needs: each entry's id keys, and whether it was
 * rated. So it stays small even for a big Trakt library. It is valid only after a
 * clean run (every write taken, no removal held back): after a failed write, the
 * item would look removed next time. It is dropped when the sync settings change
 * (`settingsSig`) or an account is connected or disconnected.
 *
 * A removal can leave a copy that sync never deletes (Trakt watch history). Then
 * the lists that removed the item keep a REMOVED mark for it (`x`), so the next
 * sync still reads it as removed there and does not add it back from that copy.
 * The mark goes when the user adds the item to that list again.
 */
import type { Tracker } from "../trackers/types";
import type { ListEntry, ListSyncSettings, SyncIds, SyncPlan, SyncWrite, TargetRef } from "./types";

/** Bump when the saved shape changes: an older base is then ignored. */
export const BASE_VERSION = 1;

/** One entry of a tracker's list at the base: its id keys (`anilist:1`,
 * `tv:tmdb:1399`, ...), whether it was rated (`r`), and its rated seasons (`s`,
 * Trakt only). `x` = a removed mark: the user removed the item from this list,
 * and another list keeps a copy sync never deletes. */
export interface BaseEntry {
  k: string[];
  r?: 1;
  s?: number[];
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
 * base. `planAt` is the preview's `at`. */
export interface PendingBase {
  v: number;
  planAt: number;
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

/** A tracker's list as base entries. Pure. */
export function baseOf(entries: ListEntry[]): BaseEntry[] {
  return entries.map((e) => {
    const b: BaseEntry = { k: entryKeys(e) };
    if (e.rating !== null) b.r = 1;
    if (e.shape === "seasons" && e.seasonRatings) {
      const s = Object.keys(e.seasonRatings).map(Number);
      if (s.length) b.s = s;
    }
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
 * a removal drops the entry, an unrate clears its rating. This is what the lists hold once every write is
 * taken, without reading them again. Pure.
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
      list.push(e);
    } else {
      for (const k of keys) if (!e.k.includes(k)) e.k.push(k);
    }
    if (w.op === "rating") {
      if (w.level === "season" && w.season !== undefined)
        e.s = [...new Set([...(e.s ?? []), w.season])];
      else e.r = 1;
    } else if (w.op === "unrate") {
      if (w.level === "season") {
        e.s = (e.s ?? []).filter((n) => n !== w.season);
        if (!e.s.length) e.s = undefined;
      } else e.r = undefined;
    }
  }
  return out;
}
