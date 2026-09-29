import { afterEach, describe, expect, it, vi } from "vitest";
import { anilistEntries, readAniListEntries } from "./list";

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

vi.mock("./auth", () => ({ getValidAccessToken: async () => "token" }));

describe("readAniListList", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads entries only a custom list holds, once each", async () => {
    const entry = (mediaId: number, extra: object = {}) => ({ mediaId, media: {}, ...extra });
    const replies = [
      { Viewer: { id: 7, mediaListOptions: { scoreFormat: "POINT_10" } } },
      {
        MediaListCollection: {
          hasNextChunk: false,
          lists: [
            // A custom list first: its copy of 1 must not win over the status list's.
            { isCustomList: true, entries: [entry(1), entry(2, { hiddenFromStatusLists: true })] },
            { isCustomList: false, entries: [entry(1, { progress: 3 })] },
          ],
        },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: replies.shift() }))),
    );
    const { entries, scoreFormat } = await readAniListEntries();
    expect(scoreFormat).toBe("POINT_10");
    expect(entries.map((e) => [e.id, e.shape === "cour" && e.progress, e.private])).toEqual([
      [1, 3, false],
      [2, 0, true],
    ]);
  });
});
