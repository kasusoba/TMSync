import { describe, expect, it } from "vitest";
import { traktEntries } from "./list";

const got = {
  title: "Game of Thrones",
  year: 2011,
  ids: { trakt: 1390, tmdb: 1399, imdb: "tt0944947", tvdb: 121361 },
};
const heat = {
  title: "Heat",
  year: 1995,
  ids: { trakt: 1, tmdb: 949, imdb: "tt0113277", tvdb: null },
};
const rated = {
  title: "Rated Only",
  year: 2020,
  ids: { trakt: 2, tmdb: 5, imdb: null, tvdb: null },
};

describe("traktEntries", () => {
  it("reads watched shows, movies, and ratings (rated-only items included)", () => {
    const entries = traktEntries({
      shows: [
        {
          last_watched_at: "2024-01-02T00:00:00.000Z",
          show: got,
          seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }] }],
        },
      ],
      movies: [{ last_watched_at: "2024-01-01T00:00:00.000Z", movie: heat }],
      showRatings: [{ rating: 9, rated_at: "2024-02-01T00:00:00.000Z", show: got }],
      seasonRatings: [{ rating: 7, show: got, season: { number: 1 } }],
      movieRatings: [{ rating: 8, movie: rated }, { rating: "bad" }],
    });
    expect(entries).toEqual([
      expect.objectContaining({
        shape: "seasons",
        id: 1390,
        ids: { tmdb: 1399, tvdb: 121361, imdb: "tt0944947" },
        seasons: { 1: [1, 2] },
        rating: 90,
        seasonRatings: { 1: 70 },
        updatedAt: Date.parse("2024-02-01T00:00:00.000Z"),
      }),
      expect.objectContaining({ shape: "movie", id: 1, watched: true, rating: null }),
      expect.objectContaining({ shape: "movie", id: 2, watched: false, rating: 80 }),
    ]);
  });
});
