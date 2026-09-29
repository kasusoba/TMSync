import { describe, expect, it } from "vitest";
import { simklEntries } from "./list";

describe("simklEntries", () => {
  it("reads shows as seasons, anime as cours, and movies", () => {
    const entries = simklEntries({
      shows: [
        {
          status: "watching",
          user_rating: 8,
          last_watched_at: "2026-05-15T00:35:15Z",
          user_rated_at: "2026-06-01T00:00:00Z",
          show: {
            title: "The Walking Dead",
            year: 2010,
            ids: { simkl: 2090, imdb: "tt1520211", tvdb: "153021" },
          },
          seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }] }],
        },
      ],
      anime: [
        {
          status: "completed",
          watched_episodes_count: 26,
          total_episodes_count: 26,
          last_watched_at: "1970-01-01T00:00:01Z",
          show: {
            title: "Cowboy Bebop",
            year: 1998,
            ids: { simkl: 37089, mal: "1", anidb: "23", anilist: "1" },
          },
          anime_type: "tv",
        },
      ],
      movies: [
        {
          status: "plantowatch",
          movie: { title: "Heat", year: 1995, ids: { simkl: 5, tmdb: "949" } },
        },
      ],
    });
    expect(entries).toEqual([
      expect.objectContaining({
        shape: "seasons",
        id: 2090,
        ids: { tvdb: 153021, imdb: "tt1520211" },
        seasons: { 1: [1, 2] },
        rating: 80,
        status: "CURRENT",
        // The rating moves the last change, not the watch date.
        updatedAt: Date.parse("2026-06-01T00:00:00Z"),
        watchedAt: Date.parse("2026-05-15T00:35:15Z"),
      }),
      expect.objectContaining({
        shape: "cour",
        id: 37089,
        ids: { mal: 1, anilist: 1 },
        progress: 26,
        total: 26,
        status: "COMPLETED",
        updatedAt: undefined,
      }),
      expect.objectContaining({
        shape: "movie",
        id: 5,
        watched: false,
        status: "PLANNING",
        ids: { tmdb: 949 },
      }),
    ]);
  });

  it("reads an empty library", () => {
    expect(simklEntries({})).toEqual([]);
  });
});
