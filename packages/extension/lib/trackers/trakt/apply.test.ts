import { describe, expect, it } from "vitest";
import type { SyncWrite } from "../../sync/types";
import { historyBody, ratingsBody, statusBodies, traktIds } from "./apply";

const show = { id: 11, ids: { tmdb: 1399, imdb: "tt0944947" }, mediaType: "show" as const };
const movie = { ids: { tmdb: 603 }, mediaType: "movie" as const };

describe("Trakt bodies", () => {
  it("names an item by its Trakt id and every other id", () => {
    expect(traktIds(show)).toEqual({ trakt: 11, tmdb: 1399, imdb: "tt0944947" });
  });

  it("dates a watch by the source, else the air date", () => {
    const writes: SyncWrite[] = [
      {
        tracker: "trakt",
        op: "episodes",
        target: show,
        add: [
          { season: 1, number: 1 },
          { season: 1, number: 2 },
          { season: 2, number: 1 },
        ],
        at: Date.UTC(2024, 0, 2),
      },
      { tracker: "trakt", op: "movie", target: movie },
    ];
    const { body, at } = historyBody(writes);
    expect(at).toEqual([0, 1]);
    expect(body.shows).toEqual([
      {
        ids: { trakt: 11, tmdb: 1399, imdb: "tt0944947" },
        seasons: [
          {
            number: 1,
            episodes: [
              { number: 1, watched_at: "2024-01-02T00:00:00.000Z" },
              { number: 2, watched_at: "2024-01-02T00:00:00.000Z" },
            ],
          },
          { number: 2, episodes: [{ number: 1, watched_at: "2024-01-02T00:00:00.000Z" }] },
        ],
      },
    ]);
    expect(body.movies).toEqual([{ ids: { tmdb: 603 }, watched_at: "released" }]);
  });

  it("leaves out episodes with no season (Trakt needs one)", () => {
    const w: SyncWrite = { tracker: "trakt", op: "episodes", target: show, add: [{ number: 3 }] };
    expect(historyBody([w]).at).toEqual([]);
  });

  it("nests a season rating in its show, on the 1 to 10 scale", () => {
    const writes: SyncWrite[] = [
      { tracker: "trakt", op: "rating", level: "season", season: 3, target: show, score: 84 },
      { tracker: "trakt", op: "rating", level: "movie", target: movie, score: 70 },
    ];
    expect(ratingsBody(writes).body).toEqual({
      movies: [{ ids: { tmdb: 603 }, rating: 7 }],
      shows: [
        { ids: { trakt: 11, tmdb: 1399, imdb: "tt0944947" }, seasons: [{ number: 3, rating: 8 }] },
      ],
    });
  });
});

describe("ratingsBody: unrate", () => {
  it("builds the ratings/remove body with no rating values", () => {
    const w: SyncWrite = {
      tracker: "trakt",
      op: "unrate",
      level: "season",
      season: 2,
      target: { id: 9, ids: { tmdb: 50 }, mediaType: "show" },
      was: 80,
    };
    expect(ratingsBody([w]).at).toEqual([]);
    const out = ratingsBody([w], "unrate");
    expect(out.at).toEqual([0]);
    expect(out.body.shows).toEqual([{ ids: { trakt: 9, tmdb: 50 }, seasons: [{ number: 2 }] }]);
  });
});

describe("Trakt status bodies", () => {
  const st = (target: typeof show | typeof movie, from: string | null, to: string): SyncWrite =>
    ({ tracker: "trakt", op: "status", target, status: { from, to } }) as SyncWrite;

  it("moves items between the watchlist and the dropped list", () => {
    const b = statusBodies([
      st(movie, null, "PLANNING"),
      st(show, "PLANNING", "DROPPED"),
      st(show, "DROPPED", "CURRENT"),
    ]);
    expect(b["/sync/watchlist"]).toEqual({
      body: { movies: [{ ids: { tmdb: 603 } }], shows: [] },
      at: [0],
    });
    expect(b["/sync/watchlist/remove"].at).toEqual([1]);
    expect(b["/users/hidden/dropped"].at).toEqual([1]);
    expect(b["/users/hidden/dropped/remove"].at).toEqual([2]);
  });
});
