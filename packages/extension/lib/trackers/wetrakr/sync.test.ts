import { describe, expect, it } from "vitest";
import { planSync } from "../../sync/plan/index";
import { DEFAULT_SYNC_SETTINGS, type ListEntry, type SyncWrite } from "../../sync/types";
import { Animap } from "../animap/index";
import { inNotFound, ratingsBody, statusBody, trackingBody, wetrakrRef } from "./apply";
import { wetrakrEntries } from "./list";

const empty = {
  shows: [],
  episodePlays: [],
  movies: [],
  showRatings: [],
  seasonRatings: [],
  movieRatings: [],
};

describe("wetrakrEntries", () => {
  it("builds a show from its list row, its plays, and its ratings", () => {
    const [bb] = wetrakrEntries({
      ...empty,
      shows: [{ id: 1, title: "Breaking Bad", ids: { tmdb: 1396 }, first_air_date: "2008-01-20" }],
      episodePlays: [
        { show_id: 1, season_number: 1, number: 2, watched_at: "2026-09-02T00:00:00Z" },
        { show_id: 1, season_number: 1, number: 1, watched_at: "2026-09-01T00:00:00Z" },
        { show_id: 1, season_number: 1, number: 1, watched_at: "2026-09-03T00:00:00Z" },
      ],
      showRatings: [
        { id: 1, title: "Breaking Bad", interactions: { user: { rating: { rating: 9.5 } } } },
      ],
      seasonRatings: [
        { media_id: 1, number: 1, interactions: { user: { rating: { rating: 8 } } } },
      ],
    });
    expect(bb).toMatchObject({
      tracker: "wetrakr",
      shape: "seasons",
      id: 1,
      title: "Breaking Bad",
      year: 2008,
      ids: { tmdb: 1396 },
      seasons: { 1: [1, 2] },
      rating: 95,
      seasonRatings: { 1: 80 },
      watchedAt: Date.parse("2026-09-03T00:00:00Z"),
    });
  });

  it("reads a show's status from its list, any list but watched winning", () => {
    const out = wetrakrEntries({
      ...empty,
      shows: [
        { id: 1, title: "A", ids: { tmdb: 1 }, list: "watched" },
        { id: 1, title: "A", ids: { tmdb: 1 }, list: "waiting" },
        { id: 2, title: "B", ids: { tmdb: 2 }, list: "planning" },
      ],
      movies: [{ id: 3, title: "C", ids: { tmdb: 3 } }],
      movieStatus: [{ id: 4, title: "D", ids: { tmdb: 4 }, list: "dropped" }],
    });
    expect(out.map((e) => [e.id, e.shape !== "cour" && e.status])).toEqual([
      [1, "CURRENT"],
      [2, "PLANNING"],
      [3, "COMPLETED"],
      [4, "DROPPED"],
    ]);
  });

  it("reads watched and rated movies, and skips rows that do not fit", () => {
    const out = wetrakrEntries({
      ...empty,
      movies: [
        {
          id: 126,
          title: "The Dark Knight",
          ids: { imdb: "tt0468569" },
          release_date: "2008-07-18",
        },
        { bad: 1 },
      ],
      movieRatings: [{ id: 7, title: "Heat", interactions: { user: { rating: { rating: 7 } } } }],
    });
    expect(out.map((e) => [e.id, e.shape === "movie" && e.watched, e.rating])).toEqual([
      [126, true, null],
      [7, false, 70],
    ]);
  });
});

describe("apply bodies", () => {
  const show = { mediaType: "show" as const, ids: { tmdb: 1396, imdb: "tt0903747" } };

  it("names an item by its WeTrakr id, else by one external id", () => {
    expect(wetrakrRef({ ...show, id: 5 })).toEqual({ id: 5 });
    expect(wetrakrRef(show)).toEqual({ ids: { tmdb: 1396 } });
    expect(wetrakrRef({ mediaType: "movie", ids: {} })).toBeNull();
  });

  it("marks each episode watched, with the source date or the release date", () => {
    const writes: SyncWrite[] = [
      {
        tracker: "wetrakr",
        op: "episodes",
        target: show,
        add: [{ season: 1, number: 1 }, { number: 9 }],
        at: 0,
      },
      { tracker: "wetrakr", op: "movie", target: { mediaType: "movie", ids: { tmdb: 155 } } },
    ];
    expect(trackingBody(writes)).toEqual({
      body: {
        shows: [
          {
            ids: { tmdb: 1396 },
            seasons: [
              {
                number: 1,
                episodes: [
                  { number: 1, status: "watched", tracked_at: "1970-01-01T00:00:00.000Z" },
                ],
              },
            ],
          },
        ],
        movies: [{ ids: { tmdb: 155 }, status: "watched", use_release_date: true }],
      },
      at: [0, 1],
    });
  });

  it("rates on 1 to 10 and nests a season rating", () => {
    const writes: SyncWrite[] = [
      { tracker: "wetrakr", op: "rating", target: show, level: "season", season: 2, score: 80 },
      { tracker: "wetrakr", op: "unrate", target: show, level: "show", was: 70 },
    ];
    expect(ratingsBody(writes).body.shows).toEqual([
      { ids: { tmdb: 1396 }, seasons: [{ number: 2, rating: 8 }] },
    ]);
    expect(ratingsBody(writes, "unrate").body.shows).toEqual([{ ids: { tmdb: 1396 } }]);
  });

  it("reads WeTrakr's notFound echo", () => {
    const data = { notFound: { movies: [{ ids: { tmdb: 155 }, status: "watched" }], shows: [] } };
    expect(inNotFound(data, { ids: { tmdb: 155 } })).toBe(true);
    expect(inNotFound(data, { ids: { tmdb: 1 } })).toBe(false);
  });
});

describe("planning with WeTrakr", () => {
  it("copies Trakt watches to WeTrakr and never removes from it", () => {
    const base = { title: "Severance", ids: { tmdb: 95396 }, rating: null } as const;
    const entries: ListEntry[] = [
      { ...base, tracker: "trakt", shape: "seasons", id: 1, seasons: { 1: [1, 2] } },
      { ...base, tracker: "wetrakr", shape: "seasons", id: 2, seasons: { 1: [1] } },
    ];
    const plan = planSync({
      entries,
      trackers: ["trakt", "wetrakr"],
      settings: DEFAULT_SYNC_SETTINGS,
      animap: new Animap([]),
      scales: {},
    });
    const writes = plan.items.flatMap((i) => i.writes);
    expect(writes).toEqual([
      expect.objectContaining({
        tracker: "wetrakr",
        op: "episodes",
        add: [{ season: 1, number: 2 }],
      }),
    ]);
    expect(writes.some((w) => w.op === "remove")).toBe(false);
  });
});

describe("WeTrakr statuses", () => {
  it("sets a show's list with no seasons, and clears what WeTrakr cannot hold", () => {
    const st = (mediaType: "movie" | "show", from: string | null, to: string): SyncWrite =>
      ({
        tracker: "wetrakr",
        op: "status",
        target: { ids: { tmdb: 9 }, mediaType },
        status: { from, to },
      }) as SyncWrite;
    expect(statusBody([st("show", null, "PAUSED"), st("movie", "PLANNING", "CURRENT")])).toEqual({
      body: {
        shows: [{ ids: { tmdb: 9 }, status: "paused" }],
        movies: [{ ids: { tmdb: 9 }, status: "none" }],
      },
      at: [0, 1],
    });
  });
});
