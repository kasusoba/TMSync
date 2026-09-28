import { describe, expect, it } from "vitest";
import { inNotFound } from "../../sync/pace";
import type { SyncWrite } from "../../sync/types";
import { simklBodies, simklItemIds } from "./apply";

const anime = {
  id: 40,
  ids: { anilist: 30, mal: 300, tmdb: 50 },
  mediaType: "show" as const,
  anime: true,
};

describe("Simkl bodies", () => {
  it("names an anime by its cour ids only", () => {
    expect(simklItemIds(anime)).toEqual({ simkl: 40, mal: "300", anilist: "30" });
  });

  it("sends an anime entry as a show with numbered episodes and a status", () => {
    const w: SyncWrite = {
      tracker: "simkl",
      op: "entry",
      target: anime,
      create: false,
      progress: { from: 2, to: 4 },
      status: { from: "CURRENT", to: "COMPLETED" },
    };
    const { history } = simklBodies([w]);
    expect(history.body.shows).toEqual([
      {
        ids: { simkl: 40, mal: "300", anilist: "30" },
        status: "completed",
        episodes: [{ number: 3 }, { number: 4 }],
      },
    ]);
  });

  it("marks an anime movie watched as a whole", () => {
    const w: SyncWrite = {
      tracker: "simkl",
      op: "entry",
      target: { ...anime, mediaType: "movie" },
      create: true,
      progress: { from: 0, to: 1 },
    };
    expect(simklBodies([w]).history.body.shows).toEqual([
      { ids: { simkl: 40, mal: "300", anilist: "30" }, status: "completed" },
    ]);
  });

  it("puts removals and ratings in their own bodies, anime under shows", () => {
    const writes: SyncWrite[] = [
      { tracker: "simkl", op: "remove", target: anime, was: {} },
      { tracker: "simkl", op: "rating", level: "entry", target: anime, score: 76 },
      {
        tracker: "simkl",
        op: "movie",
        target: { ids: { imdb: "tt1" }, mediaType: "movie" },
        at: Date.UTC(2020, 5, 1),
      },
    ];
    const b = simklBodies(writes);
    expect(b.remove.body).toEqual({ movies: [], shows: [{ ids: simklItemIds(anime) }] });
    expect(b.ratings.body.shows).toEqual([{ ids: simklItemIds(anime), rating: 8 }]);
    expect(b.history.body.movies).toEqual([
      { ids: { imdb: "tt1" }, watched_at: "2020-06-01T00:00:00.000Z" },
    ]);
  });

  it("counts a write with nothing for Simkl as done", () => {
    const w: SyncWrite = { tracker: "simkl", op: "entry", target: anime, create: false };
    expect(simklBodies([w]).nothing).toEqual([0]);
  });
});

describe("inNotFound", () => {
  const reply = { not_found: { shows: [{ ids: { mal: "300", anilist: "30" } }], movies: [] } };
  it("finds an echo whose ids all equal ours, as strings", () => {
    expect(inNotFound(reply, { mal: 300, anilist: 30 })).toBe(true);
  });
  it("does not match an item that only shares one id", () => {
    expect(inNotFound(reply, { mal: 300, anilist: 31 })).toBe(false);
    expect(inNotFound({ not_found: { shows: [] } }, { mal: 300 })).toBe(false);
    expect(inNotFound(undefined, { mal: 300 })).toBe(false);
  });
});

describe("simklBodies: unrate", () => {
  it("sends a cleared rating to its own body", () => {
    const w: SyncWrite = {
      tracker: "simkl",
      op: "unrate",
      level: "movie",
      target: { id: 5, ids: { tmdb: 11 }, mediaType: "movie" },
      was: 70,
    };
    const out = simklBodies([w]);
    expect(out.unrate.at).toEqual([0]);
    expect(out.ratings.at).toEqual([]);
    expect(out.unrate.body.movies).toHaveLength(1);
  });
});
