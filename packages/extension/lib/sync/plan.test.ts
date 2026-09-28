import { describe, expect, it } from "vitest";
import { Animap, type AnimapRow } from "../trackers/animap/index";
import type { Tracker } from "../trackers/types";
import { planSync, summarize, takesKind } from "./plan";
import { onScale } from "./score";
import {
  DEFAULT_SYNC_SETTINGS,
  type ListEntry,
  type ListSyncSettings,
  type SyncPlan,
  type SyncWrite,
} from "./types";

// Attack on Titan shape: TMDB 1429 S3 is split into two AniList entries.
const rows: AnimapRow[] = [
  { a: 16498, m: 16498, t: 1429, k: "tv", s: 1, o: null },
  { a: 99147, m: 35760, t: 1429, k: "tv", s: 3, o: null }, // S3 part 1
  { a: 104578, m: 38524, t: 1429, k: "tv", s: 3, o: 12 }, // S3 part 2
  { a: 30, m: 300, t: 50, k: "tv", s: 1, o: null }, // a one-cour show
  { a: 500, m: 5000, t: 999, k: "movie" },
];
const animap = new Animap(rows);
const ALL: Tracker[] = ["trakt", "anilist", "mal", "simkl"];

function plan(
  entries: ListEntry[],
  opts: { trackers?: Tracker[]; settings?: Partial<ListSyncSettings> } = {},
): SyncPlan {
  return planSync({
    entries,
    trackers: opts.trackers ?? ALL,
    settings: { ...DEFAULT_SYNC_SETTINGS, ...opts.settings },
    animap,
    scales: { anilist: "POINT_100" },
  });
}

const writesFor = (p: SyncPlan, tracker: Tracker): SyncWrite[] =>
  p.items.flatMap((i) => i.writes).filter((w) => w.tracker === tracker);

// --- entry builders ---

const traktShow = (tmdb: number, seasons: Record<number, number[]>, extra = {}): ListEntry => ({
  tracker: "trakt",
  shape: "seasons",
  id: tmdb + 1_000_000,
  title: `Show ${tmdb}`,
  ids: { tmdb },
  rating: null,
  seasons,
  ...extra,
});
const simklShow = (
  ids: ListEntry["ids"],
  seasons: Record<number, number[]>,
  extra = {},
): ListEntry => ({
  tracker: "simkl",
  shape: "seasons",
  id: 7,
  title: "Simkl show",
  ids,
  rating: null,
  seasons,
  ...extra,
});
const courEntry = (
  tracker: "anilist" | "mal" | "simkl",
  ids: ListEntry["ids"],
  fields: Partial<Extract<ListEntry, { shape: "cour" }>> = {},
): ListEntry => ({
  tracker,
  shape: "cour",
  id: (tracker === "mal" ? ids.mal : ids.anilist) ?? 1,
  title: "Cour",
  ids,
  rating: null,
  progress: 0,
  total: 12,
  status: "CURRENT",
  repeat: 0,
  ...fields,
});

/**
 * Apply a plan to the lists the way the trackers would, so a second plan can be
 * checked for zero writes (the main test: sync must converge).
 */
function apply(entries: ListEntry[], p: SyncPlan): ListEntry[] {
  const out = entries.map((e) => structuredClone(e));
  for (const w of p.items.flatMap((i) => i.writes)) {
    const find = () =>
      out.find(
        (e) =>
          e.tracker === w.tracker &&
          (w.target.id !== undefined
            ? e.id === w.target.id
            : (w.target.ids.tmdb !== undefined && e.ids.tmdb === w.target.ids.tmdb) ||
              (w.target.ids.anilist !== undefined && e.ids.anilist === w.target.ids.anilist) ||
              (w.target.ids.mal !== undefined && e.ids.mal === w.target.ids.mal)),
      );
    let e = find();
    if (w.op === "remove") {
      if (e) out.splice(out.indexOf(e), 1);
      continue;
    }
    if (w.op === "episodes") {
      if (!e) {
        e = {
          tracker: w.tracker,
          shape: "seasons",
          id: 900 + out.length,
          title: "new",
          ids: w.target.ids,
          rating: null,
          seasons: {},
        };
        out.push(e);
      }
      if (e.shape === "seasons") {
        for (const ep of w.add) {
          const s = ep.season ?? 1;
          e.seasons[s] = [...(e.seasons[s] ?? []), ep.number];
        }
      }
    } else if (w.op === "movie") {
      if (!e)
        out.push({
          tracker: w.tracker,
          shape: "movie",
          id: 900 + out.length,
          title: "new",
          ids: w.target.ids,
          rating: null,
          watched: true,
        });
      else if (e.shape === "movie") e.watched = true;
    } else if (w.op === "entry") {
      if (!e) {
        e = {
          tracker: w.tracker,
          shape: "cour",
          id: w.target.ids[w.tracker === "mal" ? "mal" : "anilist"] ?? 0,
          title: "new",
          ids: w.target.ids,
          rating: null,
          progress: 0,
          total: 12,
          status: null,
          repeat: 0,
        };
        out.push(e);
      }
      if (e.shape === "cour") {
        if (w.progress) e.progress = w.progress.to;
        if (w.status) e.status = w.status.to;
        if (w.repeat) e.repeat = w.repeat.to;
      }
    } else if (w.op === "rating") {
      // A rating lists the item on its own (Trakt keeps ratings apart from history,
      // and its reader returns rated-only items as entries).
      if (!e) {
        e =
          w.target.mediaType === "movie"
            ? {
                tracker: w.tracker,
                shape: "movie",
                id: 900 + out.length,
                title: "new",
                ids: w.target.ids,
                rating: null,
                watched: false,
              }
            : {
                tracker: w.tracker,
                shape: "seasons",
                id: 900 + out.length,
                title: "new",
                ids: w.target.ids,
                rating: null,
                seasons: {},
              };
        out.push(e);
      }
      if (w.level === "season" && e.shape === "seasons") {
        e.seasonRatings = { ...e.seasonRatings, [w.season as number]: w.score };
      } else if (e) e.rating = w.score;
    }
  }
  return out;
}

function expectConverges(entries: ListEntry[], opts: Parameters<typeof plan>[1] = {}) {
  const first = plan(entries, opts);
  const second = plan(apply(entries, first), opts);
  expect(second.items).toEqual([]);
  return first;
}

describe("movies and non-anime TV", () => {
  it("unions watched episodes both ways between Trakt and Simkl", () => {
    const p = plan([
      traktShow(1399, { 1: [1, 2, 3] }),
      simklShow({ tmdb: 1399, imdb: "tt0944947" }, { 1: [3, 4] }),
    ]);
    expect(writesFor(p, "trakt")).toEqual([
      expect.objectContaining({ op: "episodes", add: [{ season: 1, number: 4 }] }),
    ]);
    expect(writesFor(p, "simkl")).toEqual([
      expect.objectContaining({
        op: "episodes",
        add: [
          { season: 1, number: 1 },
          { season: 1, number: 2 },
        ],
      }),
    ]);
  });

  it("matches on any shared id, not only tmdb", () => {
    const p = plan([
      traktShow(1399, { 1: [1] }, { ids: { tmdb: 1399, tvdb: 121361 } }),
      simklShow({ tvdb: 121361 }, { 1: [1] }),
    ]);
    expect(p.items).toEqual([]);
  });

  it("never sends non-anime to a cour tracker", () => {
    const p = plan([traktShow(1399, { 1: [1, 2] })]);
    expect(writesFor(p, "anilist")).toEqual([]);
    expect(writesFor(p, "mal")).toEqual([]);
  });

  it("copies a watched movie", () => {
    const p = plan([
      {
        tracker: "trakt",
        shape: "movie",
        id: 1,
        title: "Heat",
        ids: { tmdb: 949 },
        rating: null,
        watched: true,
      },
    ]);
    expect(writesFor(p, "simkl")).toEqual([expect.objectContaining({ op: "movie" })]);
  });

  it("converges", () => {
    expectConverges([
      traktShow(1399, { 1: [1, 2, 3] }, { rating: 80 }),
      simklShow({ tmdb: 1399 }, { 1: [3, 4], 2: [1] }),
    ]);
  });
});

describe("ratings", () => {
  it("fills an empty rating and does not loop on rounding", () => {
    const entries = [
      courEntry("anilist", { anilist: 30, mal: 300 }, { rating: 85 }),
      courEntry("mal", { anilist: 30, mal: 300 }),
    ];
    const p = expectConverges(entries);
    expect(writesFor(p, "mal")).toContainEqual(
      expect.objectContaining({ op: "rating", level: "entry", score: onScale(85, "ten") }),
    );
  });

  it("treats scores equal on the target's scale as the same", () => {
    const p = plan([
      courEntry("anilist", { anilist: 30, mal: 300 }, { rating: 85 }),
      courEntry("mal", { anilist: 30, mal: 300 }, { rating: 90 }),
    ]);
    expect(p.conflicts).toEqual([]);
  });

  it("does not pick between two real ratings", () => {
    const p = plan(
      [
        courEntry("anilist", { anilist: 30, mal: 300 }, { rating: 60 }),
        courEntry("mal", { anilist: 30, mal: 300 }, { rating: 90 }),
      ],
      { trackers: ["anilist", "mal", "simkl"] },
    );
    expect(writesFor(p, "simkl").filter((w) => w.op === "rating")).toEqual([]);
    expect(p.conflicts).toEqual([expect.objectContaining({ field: "rating", chosen: null })]);
  });

  it("maps a one-cour show's score to the Trakt show rating", () => {
    const p = plan(
      [
        courEntry("anilist", { anilist: 30 }, { rating: 70, progress: 12, status: "COMPLETED" }),
        traktShow(50, { 1: [1] }),
      ],
      { trackers: ["trakt", "anilist"] },
    );
    expect(writesFor(p, "trakt")).toContainEqual(
      expect.objectContaining({ op: "rating", level: "show", score: 70 }),
    );
  });

  it("maps a whole-season cour to the Trakt season rating, and a split cour to nothing", () => {
    const p = plan(
      [
        courEntry("anilist", { anilist: 16498 }, { rating: 90 }),
        courEntry("anilist", { anilist: 99147 }, { rating: 80 }),
        traktShow(1429, { 1: [1] }),
      ],
      { trackers: ["trakt", "anilist"] },
    );
    const ratings = writesFor(p, "trakt").filter((w) => w.op === "rating");
    expect(ratings).toEqual([expect.objectContaining({ level: "season", season: 1, score: 90 })]);
  });
});

describe("anime across numbering families", () => {
  it("maps Trakt episodes of a split season to the right cour", () => {
    const p = plan([traktShow(1429, { 3: [1, 2, 13, 14] })], {
      trackers: ["trakt", "anilist", "mal"],
    });
    const al = writesFor(p, "anilist");
    expect(al).toContainEqual(
      expect.objectContaining({
        op: "entry",
        create: true,
        target: expect.objectContaining({ ids: expect.objectContaining({ anilist: 99147 }) }),
        progress: { from: 0, to: 2 },
      }),
    );
    expect(al).toContainEqual(
      expect.objectContaining({
        target: expect.objectContaining({ ids: expect.objectContaining({ anilist: 104578 }) }),
        progress: { from: 0, to: 2 },
      }),
    );
    // MAL gets the same cours by its own id.
    expect(writesFor(p, "mal")).toContainEqual(
      expect.objectContaining({
        target: expect.objectContaining({ ids: expect.objectContaining({ mal: 38524 }) }),
      }),
    );
  });

  it("maps an AniList count back to Trakt seasons", () => {
    const p = plan([courEntry("anilist", { anilist: 104578 }, { progress: 2 })], {
      trackers: ["trakt", "anilist"],
    });
    expect(writesFor(p, "trakt")).toEqual([
      expect.objectContaining({
        op: "episodes",
        target: expect.objectContaining({ ids: expect.objectContaining({ tmdb: 1429 }) }),
        add: [
          { season: 3, number: 13 },
          { season: 3, number: 14 },
        ],
      }),
    ]);
  });

  it("does not fill Trakt's own gaps from its own highest episode", () => {
    const p = plan([traktShow(50, { 1: [1, 2, 5] })], { trackers: ["trakt", "anilist"] });
    expect(writesFor(p, "trakt")).toEqual([]);
    // The cour tracker gets the highest episode, as scrobbling does.
    expect(writesFor(p, "anilist")).toEqual([
      expect.objectContaining({ progress: { from: 0, to: 5 } }),
    ]);
  });

  it("reports episodes outside the crosswalk", () => {
    const p = plan([traktShow(1429, { 0: [1, 2], 1: [1] })], { trackers: ["trakt", "anilist"] });
    expect(p.skips).toContainEqual(
      expect.objectContaining({ reason: "not_mapped", tracker: "trakt" }),
    );
  });

  it("an anime movie maps to its single cour entry", () => {
    const p = plan(
      [
        {
          tracker: "trakt",
          shape: "movie",
          id: 1,
          title: "Film",
          ids: { tmdb: 999 },
          rating: null,
          watched: true,
        },
      ],
      { trackers: ["trakt", "anilist"] },
    );
    expect(writesFor(p, "anilist")).toEqual([
      expect.objectContaining({
        create: true,
        progress: { from: 0, to: 1 },
        status: { from: null, to: "COMPLETED" },
      }),
    ]);
  });

  it("converges across all four trackers", () => {
    expectConverges([
      traktShow(1429, { 1: [1, 2, 3], 3: [1, 2, 13] }, { seasonRatings: { 1: 80 } }),
      courEntry("anilist", { anilist: 16498, mal: 16498 }, { progress: 5, total: 25 }),
      courEntry("mal", { mal: 35760 }, { progress: 4 }),
      courEntry("simkl", { anilist: 104578, mal: 38524 }, { progress: 3, status: "CURRENT" }),
    ]);
  });
});

describe("status and progress", () => {
  it("counts a rewatch in progress as finished", () => {
    const p = plan(
      [
        courEntry("anilist", { anilist: 30, mal: 300 }, { status: "REPEATING", progress: 3 }),
        courEntry("mal", { anilist: 30, mal: 300 }, { progress: 5 }),
      ],
      { trackers: ["anilist", "mal"] },
    );
    expect(writesFor(p, "mal")).toEqual([
      expect.objectContaining({
        progress: { from: 5, to: 12 },
        status: { from: "CURRENT", to: "COMPLETED" },
      }),
    ]);
    expect(writesFor(p, "anilist")).toEqual([]);
  });

  it("never moves a completed entry", () => {
    const p = plan(
      [
        courEntry(
          "anilist",
          { anilist: 30, mal: 300 },
          { status: "COMPLETED", progress: 12, updatedAt: 1 },
        ),
        courEntry(
          "mal",
          { anilist: 30, mal: 300 },
          { status: "DROPPED", progress: 4, updatedAt: 2 },
        ),
      ],
      { trackers: ["anilist", "mal"] },
    );
    expect(writesFor(p, "anilist")).toEqual([]);
  });

  it("refuses progress above the target's episode count", () => {
    const p = plan(
      [
        courEntry("anilist", { anilist: 30, mal: 300 }, { progress: 14, total: null }),
        courEntry("mal", { anilist: 30, mal: 300 }, { total: 12 }),
      ],
      { trackers: ["anilist", "mal"] },
    );
    expect(writesFor(p, "mal")).toEqual([]);
    expect(p.skips).toContainEqual(
      expect.objectContaining({ tracker: "mal", reason: "numbering" }),
    );
  });

  it("the most recent status wins, and the preview lists the conflict", () => {
    const p = plan(
      [
        courEntry(
          "anilist",
          { anilist: 30, mal: 300 },
          { status: "DROPPED", progress: 4, updatedAt: 200 },
        ),
        courEntry(
          "mal",
          { anilist: 30, mal: 300 },
          { status: "CURRENT", progress: 4, updatedAt: 100 },
        ),
      ],
      { trackers: ["anilist", "mal"] },
    );
    expect(writesFor(p, "mal")).toEqual([
      expect.objectContaining({ status: { from: "CURRENT", to: "DROPPED" } }),
    ]);
    expect(p.conflicts).toEqual([
      expect.objectContaining({
        field: "status",
        chosen: { tracker: "anilist", value: "DROPPED" },
      }),
    ]);
  });

  it("spreads a plan-to-watch entry", () => {
    const p = plan([courEntry("anilist", { anilist: 30, mal: 300 }, { status: "PLANNING" })], {
      trackers: ["anilist", "mal"],
    });
    expect(writesFor(p, "mal")).toEqual([
      expect.objectContaining({ create: true, status: { from: null, to: "PLANNING" } }),
    ]);
  });

  it("does not set plan to watch on an entry with progress", () => {
    const p = plan(
      [
        courEntry("anilist", { anilist: 30, mal: 300 }, { status: "PLANNING", updatedAt: 9 }),
        courEntry(
          "mal",
          { anilist: 30, mal: 300 },
          { status: "CURRENT", progress: 3, updatedAt: 1 },
        ),
      ],
      { trackers: ["anilist", "mal"] },
    );
    expect(writesFor(p, "mal")).toEqual([]);
    expect(writesFor(p, "anilist")).toEqual([
      expect.objectContaining({
        progress: { from: 0, to: 3 },
        status: { from: "PLANNING", to: "CURRENT" },
      }),
    ]);
  });

  it("links a MAL entry to its AniList entry through the crosswalk", () => {
    const p = plan([courEntry("mal", { mal: 300 }, { progress: 2 })], {
      trackers: ["anilist", "mal"],
    });
    expect(writesFor(p, "anilist")).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ ids: expect.objectContaining({ anilist: 30 }) }),
      }),
    ]);
  });
});

describe("privacy, ignore, and kinds", () => {
  it("skips a private AniList entry unless the user includes them", () => {
    const e = courEntry("anilist", { anilist: 30, mal: 300 }, { progress: 2, private: true });
    expect(plan([e]).items).toEqual([]);
    expect(plan([e]).skips).toContainEqual(expect.objectContaining({ reason: "private" }));
    expect(plan([e], { settings: { includePrivate: true } }).items).not.toEqual([]);
  });

  it("skips an ignored item", () => {
    const p = plan([courEntry("anilist", { anilist: 30, mal: 300 }, { progress: 2 })], {
      settings: { ignore: ["anilist:30"] },
    });
    expect(p.items).toEqual([]);
  });

  it("keeps Simkl out of anime both ways when the user turns anime off", () => {
    const settings = { kinds: { simkl: ["movie", "tv"] as const } } as Partial<ListSyncSettings>;
    const p = plan(
      [
        courEntry("simkl", { anilist: 30, mal: 300 }, { progress: 9, rating: 100 }),
        courEntry("anilist", { anilist: 30, mal: 300 }, { progress: 2 }),
        traktShow(1399, { 1: [1] }),
      ],
      { settings },
    );
    expect(writesFor(p, "simkl").map((w) => w.op)).toEqual(["episodes"]); // the non-anime show only
    expect(writesFor(p, "mal")).toEqual([
      expect.objectContaining({ progress: { from: 0, to: 2 } }),
    ]);
    expect(writesFor(p, "anilist")).toEqual([]);
  });

  it("a cour tracker can only take anime", () => {
    expect(takesKind("anilist", "movie", DEFAULT_SYNC_SETTINGS)).toBe(false);
    expect(takesKind("simkl", "movie", DEFAULT_SYNC_SETTINGS)).toBe(true);
  });
});

describe("summarize", () => {
  it("counts writes per tracker", () => {
    const p = plan([traktShow(1399, { 1: [1, 2] })], { trackers: ["trakt", "simkl"] });
    expect(summarize(p, ["trakt", "simkl"])).toEqual([
      { tracker: "trakt", episodes: 0, movies: 0, created: 0, updated: 0, ratings: 0, removed: 0 },
      { tracker: "simkl", episodes: 2, movies: 0, created: 0, updated: 0, ratings: 0, removed: 0 },
    ]);
  });
});

describe("a main list", () => {
  const main = (anime: Tracker, extra: Partial<ListSyncSettings> = {}) => ({
    settings: { main: { anime }, ...extra },
    trackers: ["trakt", "anilist", "mal"] as Tracker[],
  });

  it("removes what the main list does not have, and adds nothing back to it", () => {
    // Akira: plan to watch on MAL, removed from AniList long ago.
    const akira = courEntry("mal", { mal: 300 }, { status: "PLANNING", total: 1, movie: true });
    const p = plan([akira], main("anilist"));
    expect(writesFor(p, "mal")).toEqual([expect.objectContaining({ op: "remove" })]);
    expect(writesFor(p, "anilist")).toEqual([]);
    // Without a main list it would be copied to AniList (the union).
    expect(writesFor(plan([akira], { trackers: ["anilist", "mal"] }), "anilist")).not.toEqual([]);
  });

  it("copies the main list to the others", () => {
    const p = plan(
      [courEntry("anilist", { anilist: 30, mal: 300 }, { progress: 4 })],
      main("anilist"),
    );
    expect(writesFor(p, "mal")).toEqual([
      expect.objectContaining({ create: true, progress: { from: 0, to: 4 } }),
    ]);
  });

  it("never lowers a copy, and says so", () => {
    const p = plan(
      [
        courEntry("anilist", { anilist: 30, mal: 300 }, { progress: 6 }),
        courEntry("mal", { anilist: 30, mal: 300 }, { progress: 10 }),
      ],
      main("anilist"),
    );
    expect(writesFor(p, "mal")).toEqual([]);
    expect(writesFor(p, "anilist")).toEqual([]);
    expect(p.notices).toEqual([
      expect.objectContaining({
        tracker: "mal",
        reason: "ahead",
        detail: "episode 10 here, 6 on AniList",
      }),
    ]);
  });

  it("the main list's status wins, however old", () => {
    const p = plan(
      [
        courEntry(
          "anilist",
          { anilist: 30, mal: 300 },
          { status: "DROPPED", progress: 4, updatedAt: 1 },
        ),
        courEntry(
          "mal",
          { anilist: 30, mal: 300 },
          { status: "CURRENT", progress: 4, updatedAt: 9 },
        ),
      ],
      main("anilist"),
    );
    expect(writesFor(p, "mal")).toEqual([
      expect.objectContaining({ status: { from: "CURRENT", to: "DROPPED" } }),
    ]);
    expect(p.conflicts).toEqual([]);
  });

  it("never deletes Trakt watch history", () => {
    const p = plan([traktShow(50, { 1: [1, 2] })], main("anilist"));
    expect(writesFor(p, "trakt")).toEqual([]);
    expect(p.notices).toEqual([
      expect.objectContaining({ tracker: "trakt", reason: "history_kept" }),
    ]);
  });

  it("keeps a copy's own rating, fills an empty one from the main list only", () => {
    const p = plan(
      [
        courEntry("anilist", { anilist: 30, mal: 300 }, { rating: 80, progress: 1 }),
        courEntry("mal", { anilist: 30, mal: 300 }, { rating: 50, progress: 1 }),
        traktShow(50, { 1: [1] }, { rating: 100 }),
      ],
      main("anilist"),
    );
    expect(writesFor(p, "mal").filter((w) => w.op === "rating")).toEqual([]);
    expect(writesFor(p, "trakt").filter((w) => w.op === "rating")).toEqual([]);
    expect(
      p.notices
        .filter((n) => n.reason === "rating_kept")
        .map((n) => n.tracker)
        .sort(),
    ).toEqual(["mal", "trakt"]);
  });

  it("plans nothing of a kind whose main list was not read", () => {
    const p = plan([courEntry("mal", { mal: 300 }, { progress: 2 })], {
      settings: { main: { anime: "anilist" } },
      trackers: ["trakt", "mal"],
    });
    expect(p.items).toEqual([]);
    expect(p.skips).toEqual([expect.objectContaining({ reason: "main_missing" })]);
  });

  it("works for TV too: removes from Simkl, keeps its extra episodes", () => {
    const settings = { main: { tv: "trakt" as Tracker } };
    const p = plan(
      [
        traktShow(1399, { 1: [1, 2] }),
        simklShow({ tmdb: 1399 }, { 1: [1, 2, 3] }),
        simklShow({ tmdb: 555 }, { 1: [1] }),
      ],
      { settings, trackers: ["trakt", "simkl"] },
    );
    expect(writesFor(p, "simkl")).toEqual([
      expect.objectContaining({
        op: "remove",
        target: expect.objectContaining({ ids: { tmdb: 555 } }),
      }),
    ]);
    expect(p.notices).toEqual([expect.objectContaining({ tracker: "simkl", reason: "ahead" })]);
  });

  it("converges", () => {
    expectConverges(
      [
        courEntry("anilist", { anilist: 30, mal: 300 }, { progress: 4, rating: 70 }),
        courEntry("mal", { mal: 300 }, { progress: 2 }),
        courEntry("mal", { mal: 47 }, { status: "PLANNING" }),
        traktShow(1429, { 1: [1] }),
      ],
      main("anilist"),
    );
  });
});
