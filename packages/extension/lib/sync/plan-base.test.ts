/** Remembered removals: planning against the base (`base.ts`). */
import { describe, expect, it } from "vitest";
import { Animap } from "../trackers/animap/index";
import type { Tracker } from "../trackers/types";
import { type BaseEntry, afterWrites, baseOf, settingsSig } from "./base";
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
