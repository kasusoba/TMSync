/**
 * Saved lists for list sync (docs/ARCHITECTURE.md section 7, "Change checks"). A tracker with a
 * cheap "what changed" check (Trakt `/sync/last_activities`, Simkl
 * `/sync/activities`) saves the list it read, with the check's stamps. The next
 * read asks the check first and reuses each part whose stamp did not move, so an
 * unchanged list costs one request instead of a full read.
 *
 * A part is a slice of the list with its own stamp (Trakt: shows, movies. Simkl:
 * shows, anime, movies). The saved list is only a read cache: every read replaces
 * it, and connecting or disconnecting the account drops it, so a different account
 * on the same tracker never reuses it. It is NOT the "last synced" base of the
 * three-way merge (phase 3), which is only valid after a clean apply.
 */
import type { ScoreFormat } from "../trackers/types";
import type { ListEntry } from "./types";

/** Bump when `ListCache` or `ListEntry` changes shape: an older saved list is then
 * read again instead of reused. */
export const LIST_CACHE_VERSION = 4;

/** A tracker's list as saved after a read. */
export interface ListCache {
  v: number;
  /** When it was saved (ms). */
  at: number;
  /** The tracker's change stamps from before the read, by name. A tracker picks
   * the names (a part, or a part plus a detail, like `anime:removed`). */
  stamps: Record<string, string>;
  entries: ListEntry[];
}

/** What a tracker's list read returns. */
export interface ListRead {
  entries: ListEntry[];
  /** The user's score scale where it is theirs to pick (AniList). */
  scoreFormat?: ScoreFormat | null;
  /** The list to save for the next read. Missing = the tracker has no check, so
   * nothing is saved. */
  cache?: ListCache;
  /** How much was read: `saved` = nothing changed, the saved list was used.
   * `changes` = only the changed parts (or only the changes) were read. Missing =
   * a full read. */
  from?: "saved" | "changes";
}

/** A saved list's entries by part, or null when there is none or it is from an
 * older build. Pure. */
export function savedParts<P extends string>(
  saved: ListCache | null | undefined,
  partOf: (e: ListEntry) => P,
): Map<P, ListEntry[]> | null {
  if (!saved || saved.v !== LIST_CACHE_VERSION) return null;
  const out = new Map<P, ListEntry[]>();
  for (const e of saved.entries) {
    const p = partOf(e);
    const list = out.get(p);
    if (list) list.push(e);
    else out.set(p, [e]);
  }
  return out;
}

/** The saved entries with the changes laid over: a changed entry replaces the
 * saved one with the same id, and a new one is added. Pure. */
export function mergeById(saved: ListEntry[], changed: ListEntry[]): ListEntry[] {
  const byId = new Map(saved.map((e) => [e.id, e]));
  for (const e of changed) byId.set(e.id, e);
  return [...byId.values()];
}

/** A list to save. A missing stamp is left out, so that part is read in full
 * next time. Pure. */
export function newCache(
  stamps: Record<string, string | null | undefined>,
  entries: ListEntry[],
  now: number,
): ListCache {
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(stamps)) if (v) kept[k] = v;
  return { v: LIST_CACHE_VERSION, at: now, stamps: kept, entries };
}

/** How much a read took, from how many parts were reused, read as changes, or
 * read in full. Pure. */
export function readFrom(counts: {
  saved: number;
  changes: number;
  full: number;
}): ListRead["from"] {
  if (!counts.changes && !counts.full) return "saved";
  return counts.saved || counts.changes ? "changes" : undefined;
}
