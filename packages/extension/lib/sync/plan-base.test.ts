/** Remembered removals: planning against the base (`base.ts`). */
import { describe, expect, it } from "vitest";
import { Animap } from "../trackers/animap/index";
import type { Tracker } from "../trackers/types";
import { type BaseEntry, afterWrites, baseOf, nextLists, settingsSig } from "./base";
import { planSync } from "./plan";
import {
  DEFAULT_SYNC_SETTINGS,
  type ListEntry,
  type ListSyncSettings,
  type SyncPlan,
} from "./types";

// A one-cour anime: AniList 30 = MAL 300 = TMDB tv 50 season 1.
const animap = new Animap([{ a: 30, m: 300, t: 50, k: "tv", s: 1, o: null }]);
const ALL: Tracker[] = ["trakt", "anilist", "mal", "simkl"];

const cour = (
  tracker: "anilist" | "mal",
  fields: Partial<Extract<ListEntry, { shape: "cour" }>> = {},
): ListEntry => ({
  tracker,
  shape: "cour",
  id: tracker === "mal" ? 300 : 30,
  title: "Cour",
  ids: { anilist: 30, mal: 300 },
  rating: null,
  progress: 4,
  total: 12,
  status: "CURRENT",
  repeat: 0,
  ...fields,
});
const movie = (tracker: "trakt" | "simkl", rating: number | null = null): ListEntry => ({
  tracker,
  shape: "movie",
  id: tracker === "trakt" ? 1 : 2,
  title: "Film",
  ids: { tmdb: 11, imdb: "tt11" },
  rating,
  watched: true,
});
const traktAnime = (): ListEntry => ({
  tracker: "trakt",
  shape: "seasons",
  id: 9,
  title: "Show",
  ids: { tmdb: 50 },
  rating: null,
  seasons: { 1: [1, 2, 3, 4] },
});

function plan(
  entries: ListEntry[],
  base: ListEntry[],
  settings: Partial<ListSyncSettings> = {},
): SyncPlan {
  const byTracker: Partial<Record<Tracker, BaseEntry[]>> = {};
  for (const tk of ALL) byTracker[tk] = baseOf(base.filter((e) => e.tracker === tk));
  return planSync({
    entries,
    trackers: ALL,
    settings: { ...DEFAULT_SYNC_SETTINGS, ...settings },
    animap,
    scales: { anilist: "POINT_100" },
    base: byTracker,
  });
}
const ops = (p: SyncPlan) => p.items.flatMap((i) => i.writes).map((w) => `${w.tracker}:${w.op}`);
const rateOps = (p: SyncPlan) => ops(p).filter((o) => /:(un)?rate|:rating/.test(o));

describe("remembered removals: entries", () => {
  it("removes a cour from the others when one list removed it", () => {
    const before = [cour("anilist"), cour("mal"), traktAnime()];
    const p = plan([cour("mal"), traktAnime()], before);
    expect(ops(p)).toEqual(["mal:remove"]);
    // Trakt is watch history: kept, and said so.
    expect(p.notices).toMatchObject([
      { tracker: "trakt", reason: "history_kept", detail: "removed on AniList" },
    ]);
  });

  it("adds it back when a list that has it added it since the base", () => {
    const p = plan([cour("mal")], [cour("anilist")]);
    expect(ops(p)).toContain("anilist:entry");
  });

  it("adds it back without a base (union)", () => {
    const p = planSync({
      entries: [cour("mal")],
      trackers: ALL,
      settings: DEFAULT_SYNC_SETTINGS,
      animap,
    });
    expect(ops(p)).toContain("anilist:entry");
  });

  it("removes a movie from Simkl when Trakt history lost it, never from Trakt", () => {
    const p = plan([movie("simkl")], [movie("trakt"), movie("simkl")]);
    expect(ops(p)).toEqual(["simkl:remove"]);
    const q = plan([movie("trakt")], [movie("trakt"), movie("simkl")]);
    expect(ops(q)).toEqual([]);
    expect(q.notices).toMatchObject([{ tracker: "trakt", reason: "history_kept" }]);
  });

  it("does nothing with a main list: the main list decides", () => {
    const p = plan([cour("mal")], [cour("anilist"), cour("mal")], { main: { anime: "mal" } });
    expect(ops(p)).toContain("anilist:entry");
  });

  it("never reads a crosswalk change as a removal", () => {
    // Trakt still has the show (under another id key too): not removed.
    const moved = { ...traktAnime(), ids: { tmdb: 50, tvdb: 7 }, seasons: {} };
    const p = plan(
      [cour("anilist"), cour("mal"), moved],
      [cour("anilist"), cour("mal"), traktAnime()],
    );
    expect(ops(p).filter((o) => o.endsWith("remove"))).toEqual([]);
  });
});

/** Plan against `base`, then the base a clean apply of that plan leaves (as
 * `run.ts` and `base-store.ts` build it). */
function syncOnce(
  entries: ListEntry[],
  base: Partial<Record<Tracker, BaseEntry[]>>,
  settings: Partial<ListSyncSettings> = {},
): { plan: SyncPlan; next: Partial<Record<Tracker, BaseEntry[]>> } {
  const p = planSync({
    entries,
    trackers: ALL,
    settings: { ...DEFAULT_SYNC_SETTINGS, ...settings },
    animap,
    scales: { anilist: "POINT_100" },
    base,
  });
  const writes = p.items.flatMap((i) => i.writes);
  return { plan: p, next: afterWrites(nextLists(entries, ALL, p.removed), writes) };
}
const baseFrom = (entries: ListEntry[]) => nextLists(entries, ALL);
const NO_SIMKL_ANIME = { kinds: { simkl: ["movie", "tv"] as ("movie" | "tv")[] } };

describe("remembered removals: later syncs", () => {
  it("keeps an anime removed while Trakt history still has it", () => {
    const first = syncOnce(
      [cour("mal"), traktAnime()],
      baseFrom([cour("anilist"), cour("mal"), traktAnime()]),
      NO_SIMKL_ANIME,
    );
    expect(ops(first.plan)).toEqual(["mal:remove"]);
    // The next syncs read Trakt alone: nothing comes back, and nothing is said again.
    const second = syncOnce([traktAnime()], first.next, NO_SIMKL_ANIME);
    expect(ops(second.plan)).toEqual([]);
    expect(second.plan.notices).toEqual([]);
    const third = syncOnce([traktAnime()], second.next, NO_SIMKL_ANIME);
    expect(ops(third.plan)).toEqual([]);
  });

  it("keeps a movie removed on Simkl while Trakt history still has it", () => {
    const first = syncOnce([movie("trakt")], baseFrom([movie("trakt"), movie("simkl")]));
    expect(first.plan.notices).toMatchObject([{ tracker: "trakt", reason: "history_kept" }]);
    const second = syncOnce([movie("trakt")], first.next);
    expect(ops(second.plan)).toEqual([]);
    expect(second.plan.notices).toEqual([]);
  });

  it("adds it back everywhere once the user adds it to a list again", () => {
    const first = syncOnce(
      [cour("mal"), traktAnime()],
      baseFrom([cour("anilist"), cour("mal"), traktAnime()]),
      NO_SIMKL_ANIME,
    );
    const back = syncOnce([cour("anilist"), traktAnime()], first.next, NO_SIMKL_ANIME);
    expect(ops(back.plan)).toContain("mal:entry");
    expect(ops(back.plan).filter((o) => o.endsWith("remove"))).toEqual([]);
  });

  it("marks only the removed cour, not the other cours of the show", () => {
    // Two cours of one TMDB show: AniList 30 = season 1, AniList 31 = season 2.
    const two = new Animap([
      { a: 30, m: 300, t: 50, k: "tv", s: 1, o: null },
      { a: 31, m: 310, t: 50, k: "tv", s: 2, o: null },
    ]);
    const settings = { ...DEFAULT_SYNC_SETTINGS, ...NO_SIMKL_ANIME };
    const run = (entries: ListEntry[], base: Partial<Record<Tracker, BaseEntry[]>>) => {
      const p = planSync({ entries, trackers: ALL, settings, animap: two, base });
      const writes = p.items.flatMap((i) => i.writes);
      return { p, next: afterWrites(nextLists(entries, ALL, p.removed), writes) };
    };
    // Season 1 removed on AniList.
    const first = run(
      [cour("mal"), traktAnime()],
      nextLists([cour("anilist"), cour("mal"), traktAnime()], ALL),
    );
    expect(ops(first.p)).toEqual(["mal:remove"]);
    // Then the user watches season 2 on Trakt: it goes to AniList and MAL, and
    // season 1 stays removed (the mark names the cour, not the show).
    const watched = { ...traktAnime(), seasons: { 1: [1, 2, 3, 4], 2: [1, 2] } };
    const second = run([watched], first.next);
    expect(second.p.items.map((i) => i.key)).toEqual(["anilist:31"]);
    expect(ops(second.p).sort()).toEqual(["anilist:entry", "mal:entry"]);
  });

  it("drops the marks once no list keeps a copy", () => {
    const first = syncOnce(
      [cour("mal"), traktAnime()],
      baseFrom([cour("anilist"), cour("mal"), traktAnime()]),
      NO_SIMKL_ANIME,
    );
    // Trakt history cleared too: nothing holds it, so no mark is carried on.
    const second = syncOnce([], first.next, NO_SIMKL_ANIME);
    expect(second.plan.removed).toBeUndefined();
  });
});

describe("remembered removals: ratings", () => {
  it("clears a rating the user removed from one list", () => {
    const before = [cour("anilist", { rating: 80 }), cour("mal", { rating: 80 })];
    const p = plan([cour("anilist"), cour("mal", { rating: 80 })], before);
    const writes = p.items.flatMap((i) => i.writes).filter((w) => w.op === "unrate");
    expect(writes).toMatchObject([{ tracker: "mal", op: "unrate", was: 80 }]);
    expect(rateOps(p)).toEqual(["mal:unrate"]);
  });

  it("fills as usual when the rating is new since the base", () => {
    const p = plan(
      [cour("anilist"), cour("mal", { rating: 80 })],
      [cour("anilist", { rating: 60 }), cour("mal")],
    );
    expect(rateOps(p)).toContain("anilist:rating");
    expect(rateOps(p).filter((o) => o.endsWith("unrate"))).toEqual([]);
  });

  it("clears a movie rating on Trakt and Simkl", () => {
    const p = plan([movie("trakt"), movie("simkl", 70)], [movie("trakt", 70), movie("simkl", 70)]);
    expect(ops(p)).toEqual(["simkl:unrate"]);
  });
});

describe("afterWrites", () => {
  it("lays the applied writes over the lists", () => {
    const lists = { anilist: baseOf([cour("anilist", { rating: 80 })]), mal: [] as BaseEntry[] };
    const out = afterWrites(lists, [
      {
        tracker: "mal",
        op: "entry",
        create: true,
        target: { ids: { anilist: 30, mal: 300 }, mediaType: "show", anime: true },
      },
      {
        tracker: "anilist",
        op: "unrate",
        level: "entry",
        target: { id: 30, ids: { anilist: 30 }, mediaType: "show", anime: true },
        was: 80,
      },
    ]);
    expect(out.mal).toEqual([{ k: ["anilist:30", "mal:300"] }]);
    expect(out.anilist?.[0]?.r).toBeUndefined();
  });

  it("drops a removed entry", () => {
    const out = afterWrites({ mal: baseOf([cour("mal")]) }, [
      {
        tracker: "mal",
        op: "remove",
        target: { id: 300, ids: { mal: 300 }, mediaType: "show" },
        was: {},
      },
    ]);
    expect(out.mal).toEqual([]);
  });
});

describe("settingsSig", () => {
  it("ignores the ignore list and auto sync, not the kinds", () => {
    const a = settingsSig(DEFAULT_SYNC_SETTINGS);
    expect(settingsSig({ ...DEFAULT_SYNC_SETTINGS, ignore: ["x"], auto: true })).toBe(a);
    expect(settingsSig({ ...DEFAULT_SYNC_SETTINGS, kinds: { simkl: ["movie"] } })).not.toBe(a);
  });
});
