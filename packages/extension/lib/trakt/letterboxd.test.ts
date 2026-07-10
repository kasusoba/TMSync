import { describe, expect, it } from "vitest";
import {
  type TraktHistoryMovie,
  type TraktRatedMovie,
  buildLetterboxdRows,
  convertRating,
  formatWatchedDate,
  toLetterboxdCsv,
} from "./letterboxd";

const movie = (
  trakt: number,
  title: string,
  extra: Partial<{ year: number; imdb: string; tmdb: number }> = {},
) => ({
  title,
  year: extra.year,
  ids: { trakt, imdb: extra.imdb, tmdb: extra.tmdb },
});
const play = (trakt: number, title: string, watched_at: string): TraktHistoryMovie => ({
  movie: movie(trakt, title),
  watched_at,
});
const rated = (
  trakt: number,
  title: string,
  rating: number,
  rated_at: string,
): TraktRatedMovie => ({
  movie: movie(trakt, title),
  rating,
  rated_at,
});

describe("convertRating", () => {
  it("halves the Trakt 1–10 scale to one decimal", () => {
    expect(convertRating(10)).toBe("5.0");
    expect(convertRating(7)).toBe("3.5");
    expect(convertRating(1)).toBe("0.5");
  });
  it("is empty for unrated", () => {
    expect(convertRating(undefined)).toBe("");
    expect(convertRating(0)).toBe("");
  });
});

describe("formatWatchedDate", () => {
  it("keeps the date part of an ISO datetime", () => {
    expect(formatWatchedDate("2024-01-15T20:30:00.000Z")).toBe("2024-01-15");
  });
  it("is empty for missing/garbage", () => {
    expect(formatWatchedDate(undefined)).toBe("");
    expect(formatWatchedDate("not a date")).toBe("");
  });
});

describe("buildLetterboxdRows", () => {
  it("emits one row per play (rewatches preserved), newest first", () => {
    const rows = buildLetterboxdRows({
      history: [play(1, "Dune", "2021-10-22T00:00:00Z"), play(1, "Dune", "2024-03-01T00:00:00Z")],
      ratings: [],
      comments: [],
    });
    expect(rows.map((r) => r.WatchedDate)).toEqual(["2024-03-01", "2021-10-22"]);
    expect(rows.every((r) => r.Title === "Dune")).toBe(true);
  });

  it("attaches rating + review only to the earliest watch (stable re-import anchor)", () => {
    const rows = buildLetterboxdRows({
      history: [play(1, "Dune", "2021-10-22T00:00:00Z"), play(1, "Dune", "2024-03-01T00:00:00Z")],
      ratings: [rated(1, "Dune", 9, "2024-03-02T00:00:00Z")],
      comments: [{ movieId: 1, comment: "Spice flows.", isReview: true }],
    });
    const earliest = rows.find((r) => r.WatchedDate === "2021-10-22");
    const rewatch = rows.find((r) => r.WatchedDate === "2024-03-01");
    expect(earliest).toMatchObject({ Rating: "4.5", Review: "Spice flows." });
    expect(rewatch).toMatchObject({ Rating: "", Review: "" });
  });

  it("keeps a rated-but-never-watched film as its own row dated by rated_at", () => {
    const rows = buildLetterboxdRows({
      history: [],
      ratings: [rated(2, "Tenet", 8, "2020-09-03T00:00:00Z")],
      comments: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Title: "Tenet", WatchedDate: "2020-09-03", Rating: "4.0" });
  });

  it("prefers a flagged review, then the longest comment, per film", () => {
    const rows = buildLetterboxdRows({
      history: [play(3, "Heat", "2022-01-01T00:00:00Z")],
      ratings: [],
      comments: [
        { movieId: 3, comment: "long non-review comment that is quite lengthy", isReview: false },
        { movieId: 3, comment: "short review", isReview: true },
      ],
    });
    expect(rows[0]?.Review).toBe("short review");
  });

  it("carries ids through", () => {
    const rows = buildLetterboxdRows({
      history: [
        {
          movie: movie(4, "Sinners", { year: 2025, imdb: "tt123", tmdb: 999 }),
          watched_at: "2025-04-18T00:00:00Z",
        },
      ],
      ratings: [],
      comments: [],
    });
    expect(rows[0]).toMatchObject({ Year: "2025", imdbID: "tt123", tmdbID: "999" });
  });
});

describe("toLetterboxdCsv", () => {
  it("writes the header and escapes commas/quotes/newlines", () => {
    const csv = toLetterboxdCsv([
      {
        Title: 'The "Best", Movie',
        Year: "2024",
        Directors: "",
        WatchedDate: "2024-01-01",
        Rating: "5.0",
        Review: "line one\nline two",
        Tags: "",
        tmdbID: "1",
        imdbID: "tt1",
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Title,Year,Directors,WatchedDate,Rating,Review,Tags,tmdbID,imdbID");
    expect(lines[1]).toBe('"The ""Best"", Movie",2024,,2024-01-01,5.0,"line one\nline two",,1,tt1');
  });
});
