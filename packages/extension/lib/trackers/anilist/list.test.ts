import { describe, expect, it } from "vitest";
import { anilistEntries } from "./list";

describe("anilistEntries", () => {
  it("reads cour entries with score, privacy, and adult flags", () => {
    const [e, movie] = anilistEntries([
      {
        mediaId: 16498,
        status: "REPEATING",
        progress: 3,
        repeat: 1,
        private: true,
        updatedAt: 1700000000,
        score: 85,
        media: {
          idMal: 16498,
          episodes: 25,
          format: "TV",
          isAdult: false,
          startDate: { year: 2013 },
          title: { userPreferred: "Shingeki no Kyojin" },
        },
      },
      {
        mediaId: 1,
        status: "PLANNING",
        progress: 0,
        score: 0,
        media: { format: "MOVIE", episodes: 1 },
      },
      { mediaId: "not a number" },
    ]);
    expect(e).toEqual(
      expect.objectContaining({
        shape: "cour",
        id: 16498,
        ids: { anilist: 16498, mal: 16498 },
        rating: 85,
        private: true,
        progress: 3,
        total: 25,
        status: "REPEATING",
        repeat: 1,
        updatedAt: 1700000000000,
        movie: false,
      }),
    );
    expect(movie).toEqual(
      expect.objectContaining({ rating: null, movie: true, ids: { anilist: 1 } }),
    );
  });
});
