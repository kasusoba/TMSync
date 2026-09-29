/**
 * What every part of one planner run shares: the input, the user's settings, the
 * base and "now" indexes for remembered removals, and the plan being built. Built
 * once per `planSync` call. Pure.
 */
import type { Animap } from "../../trackers/animap/index";
import { type Tracker, trackerLabel } from "../../trackers/types";
import { type BaseEntry, BaseIndex, baseOf } from "../base";
import type { ScoreScale } from "../score";
import type {
  ListEntry,
  ListSyncSettings,
  SyncConflict,
  SyncItem,
  SyncKind,
  SyncNotice,
  SyncPlan,
  SyncSkip,
  SyncWrite,
} from "../types";
import { canBeMain, takesKind } from "./util";

export interface PlanInput {
  /** Every entry read from the trackers taking part. */
  entries: ListEntry[];
  /** The trackers taking part (connected, and their list was read). */
  trackers: Tracker[];
  settings: ListSyncSettings;
  animap: Animap;
  /** Each tracker's score scale. A missing tracker rates 1 to 10. */
  scales?: Partial<Record<Tracker, ScoreScale>>;
  /** Each tracker's list at the last sync (`base.ts`), for remembered
   * removals. Missing = none: a union adds everything back. */
  base?: Partial<Record<Tracker, BaseEntry[]>>;
}

export type CourEntry = Extract<ListEntry, { shape: "cour" }>;
export type SeasonedEntry = Extract<ListEntry, { shape: "seasons" | "movie" }>;

export interface PlanContext {
  input: PlanInput;
  settings: ListSyncSettings;
  animap: Animap;
  /** The entries of the trackers taking part. */
  entries: ListEntry[];
  scale: (tk: Tracker) => ScoreScale;
  ignored: Set<string>;
  items: SyncItem[];
  skips: SyncSkip[];
  conflicts: SyncConflict[];
  notices: SyncNotice[];
  removed: NonNullable<SyncPlan["removed"]>;
  /** The main list for a kind, when the user set one it can hold. */
  mainFor: (kind: SyncKind) => Tracker | undefined;
  unreadHas: (keys: string[]) => boolean;
  atBase: (tk: Tracker, keys: string[]) => BaseEntry | undefined;
  listedAtBase: (tk: Tracker, keys: string[]) => boolean;
  hasNow: (tk: Tracker, keys: string[]) => boolean;
  unratedAway: (tk: Tracker, keys: string[]) => boolean;
  removedSince: (
    keys: string[],
    among: Tracker[],
    holders: Tracker[],
  ) => { gone: Tracker[]; fresh: boolean };
  unratedSince: (
    present: Tracker[],
    ratedNow: (tk: Tracker) => boolean,
    ratedBase: (tk: Tracker) => boolean,
  ) => Tracker[];
  mainMissing: (kind: SyncKind, key: string, title: string) => boolean;
  /** Add an item to the plan, when it has writes. */
  push: (
    key: string,
    kind: SyncKind,
    title: string,
    year: number | undefined,
    writes: SyncWrite[],
  ) => void;
}

export const removedOn = (gone: Tracker[]) => `removed on ${gone.map(trackerLabel).join(", ")}`;

export function planContext(input: PlanInput): PlanContext {
  const { settings, animap } = input;
  const scale = (tk: Tracker): ScoreScale => input.scales?.[tk] ?? "ten";
  const taking = new Set(input.trackers);
  const entries = input.entries.filter((e) => taking.has(e.tracker));
  const ignored = new Set(settings.ignore);

  const items: SyncItem[] = [];
  const skips: SyncSkip[] = [];
  const conflicts: SyncConflict[] = [];
  const notices: SyncNotice[] = [];
  const removed: NonNullable<SyncPlan["removed"]> = [];

  /** The main list for a kind, when the user set one it can hold. */
  const mainFor = (kind: SyncKind): Tracker | undefined => {
    const m = settings.main?.[kind];
    return m && canBeMain(m) && takesKind(m, kind, settings) ? m : undefined;
  };
  // --- remembered removals (base.ts) ---
  const bases = new Map<Tracker, BaseIndex>();
  for (const [tk, list] of Object.entries(input.base ?? {}) as [Tracker, BaseEntry[]][])
    if (taking.has(tk)) bases.set(tk, new BaseIndex(list));
  // Trackers in the base that this run could not read (a failed read, or an
  // expired sign-in). They still hold what they held at the base.
  const unread = Object.entries(input.base ?? {})
    .filter(([tk]) => !taking.has(tk as Tracker))
    .map(([, list]) => new BaseIndex(list as BaseEntry[]));
  /** A tracker this run did not read had the item at the base. Its copy was not
   * removed, so the lists that remove it now keep a removed mark: without one, the
   * next run reads that copy and adds the item back. */
  const unreadHas = (keys: string[]) =>
    unread.some((b) => {
      const e = b.find(keys);
      return !!e && !e.x;
    });
  /** A tracker's base entry for an item, a removed mark included. */
  const atBase = (tk: Tracker, keys: string[]) => bases.get(tk)?.find(keys);
  /** The tracker had the item itself at the base (not a removed mark). */
  const listedAtBase = (tk: Tracker, keys: string[]) => {
    const b = atBase(tk, keys);
    return !!b && !b.x;
  };
  // What each tracker has now, by id key: a tracker "lacks" an item only when no
  // entry of it shares an id, so a crosswalk change never looks like a removal.
  const nows = new Map<Tracker, BaseIndex>(
    input.trackers.map((tk) => [
      tk,
      new BaseIndex(baseOf(entries.filter((e) => e.tracker === tk))),
    ]),
  );
  const hasNow = (tk: Tracker, keys: string[]) => !!nows.get(tk)?.find(keys);
  /** The tracker had the item only for its ratings at the base (`BaseEntry.o`), and
   * has nothing of it now: the user removed the rating, not the item. Its rating
   * counts as removed (`unratedSince`), and the item as still there. */
  const unratedAway = (tk: Tracker, keys: string[]) => !hasNow(tk, keys) && !!atBase(tk, keys)?.o;

  /**
   * The trackers that removed an item: they had it at the base (or keep a removed
   * mark for it) and have nothing of it now. Only when every tracker that has it
   * now had it at the base too (else it was added since, and the add wins).
   * `fresh` = one of them removed it since the last sync (not only an old mark),
   * so the plan tells the user about the copies it keeps.
   */
  const removedSince = (
    keys: string[],
    among: Tracker[],
    holders: Tracker[],
  ): { gone: Tracker[]; fresh: boolean } => {
    const none = { gone: [], fresh: false };
    if (!bases.size || !holders.length) return none;
    const gone = among.filter(
      (tk) => !hasNow(tk, keys) && atBase(tk, keys) && !unratedAway(tk, keys),
    );
    if (!gone.length || !holders.every((tk) => listedAtBase(tk, keys))) return none;
    return { gone, fresh: gone.some((tk) => listedAtBase(tk, keys)) };
  };

  /** The trackers whose rating to clear: some tracker that has the item had a
   * rating at the base and has none now, and every rated one was rated at the base
   * too (else a new rating wins, and fills as usual). */
  const unratedSince = (
    present: Tracker[],
    ratedNow: (tk: Tracker) => boolean,
    ratedBase: (tk: Tracker) => boolean,
  ): Tracker[] => {
    if (!bases.size) return [];
    const gone = present.filter((tk) => bases.has(tk) && ratedBase(tk) && !ratedNow(tk));
    const rated = present.filter(ratedNow);
    if (!gone.length || !rated.length || !rated.every(ratedBase)) return [];
    return rated;
  };

  /** A main list that was not read makes the whole kind unsafe to plan: with no
   * truth to copy, a union would bring back what the user removed. */
  const mainMissing = (kind: SyncKind, key: string, title: string): boolean => {
    const m = mainFor(kind);
    if (!m || input.trackers.includes(m)) return false;
    skips.push({ key, title, reason: "main_missing", detail: `${trackerLabel(m)} was not read` });
    return true;
  };

  return {
    input,
    settings,
    animap,
    entries,
    scale,
    ignored,
    items,
    skips,
    conflicts,
    notices,
    removed,
    mainFor,
    unreadHas,
    atBase,
    listedAtBase,
    hasNow,
    unratedAway,
    removedSince,
    unratedSince,
    mainMissing,
    push: (key, kind, title, year, writes) => {
      if (writes.length) items.push({ key, kind, title, year, writes });
    },
  };
}
