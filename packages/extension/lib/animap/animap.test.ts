import { describe, expect, it } from "vitest";
import { Animap, type AnimapRow, defaultAnimap } from "./index";

// Synthetic fixture mirroring the tricky Attack on Titan shape: TMDB tv 1429 season
// 3 is split into two AniList entries by an offset; season 1/2 are 1:1.
const rows: AnimapRow[] = [
  { a: 16498, t: 1429, k: "tv", s: 1, o: null }, // S1 (1:1)
  { a: 20958, t: 1429, k: "tv", s: 2, o: null }, // S2
  { a: 99147, t: 1429, k: "tv", s: 3, o: null }, // S3 part 1 (eps 1..12)
  { a: 104578, t: 1429, k: "tv", s: 3, o: 12 }, // S3 part 2 (eps 13..)
  { a: 21, t: 37854, k: "tv", s: null, o: null }, // One Piece: single ongoing entry
  { a: 500, t: 999, k: "movie" }, // a movie
  { a: 501, t: 998, k: "movie" }, // ambiguous movie (two anilist ids, one tmdb)
  { a: 502, t: 998, k: "movie" },
];
const map = new Animap(rows);

describe("animap forward (TMDB-native site → AniList)", () => {
  it("1:1 season passes the episode straight through", () => {
    expect(map.forward(1429, "tv", 1, 10)).toEqual({
      kind: "resolved",
      value: { anilistId: 16498, localEpisode: 10 },
    });
  });

  it("split season, low episode → part 1 (offset 0)", () => {
    expect(map.forward(1429, "tv", 3, 5)).toEqual({
      kind: "resolved",
      value: { anilistId: 99147, localEpisode: 5 },
    });
  });

  it("split season, high episode → part 2, local = ep − offset", () => {
    expect(map.forward(1429, "tv", 3, 15)).toEqual({
      kind: "resolved",
      value: { anilistId: 104578, localEpisode: 3 },
    });
  });

  it("boundary: episode 13 is the first of part 2", () => {
    expect(map.forward(1429, "tv", 3, 13)).toEqual({
      kind: "resolved",
      value: { anilistId: 104578, localEpisode: 1 },
    });
    expect(map.forward(1429, "tv", 3, 12)).toEqual({
      kind: "resolved",
      value: { anilistId: 99147, localEpisode: 12 },
    });
  });

  it("single ongoing entry with no season passes absolute episode through", () => {
    expect(map.forward(37854, "tv", undefined, 1000)).toEqual({
      kind: "resolved",
      value: { anilistId: 21, localEpisode: 1000 },
    });
  });

  it("multi-cour with NO season given is ambiguous (absolute numbering, refuse)", () => {
    expect(map.forward(1429, "tv", undefined, 5)).toEqual({ kind: "ambiguous" });
  });

  it("unknown tmdb id → miss (derived tracker skipped)", () => {
    expect(map.forward(424242, "tv", 1, 1)).toEqual({ kind: "miss" });
  });

  it("movie resolves to its single anilist id; two ids → ambiguous", () => {
    expect(map.forward(999, "movie", undefined, undefined)).toEqual({
      kind: "resolved",
      value: { anilistId: 500, localEpisode: 0 },
    });
    expect(map.forward(998, "movie", undefined, undefined)).toEqual({ kind: "ambiguous" });
  });

  it("tv/movie id namespaces don't collide", () => {
    // 998 exists as a movie; asking for it as tv must miss.
    expect(map.forward(998, "tv", 1, 1)).toEqual({ kind: "miss" });
  });
});

describe("animap reverse (AniList-native site → TMDB/Trakt)", () => {
  it("round-trips the AoT split: local ep + offset = tmdb ep", () => {
    expect(map.reverse(104578, 3)).toEqual({
      kind: "resolved",
      value: { tmdbId: 1429, tmdbKind: "tv", tmdbSeason: 3, tmdbEpisode: 15 },
    });
    expect(map.reverse(99147, 5)).toEqual({
      kind: "resolved",
      value: { tmdbId: 1429, tmdbKind: "tv", tmdbSeason: 3, tmdbEpisode: 5 },
    });
  });

  it("season-less entry keeps the episode as-is", () => {
    expect(map.reverse(21, 1000)).toEqual({
      kind: "resolved",
      value: { tmdbId: 37854, tmdbKind: "tv", tmdbSeason: null, tmdbEpisode: 1000 },
    });
  });

  it("movie reverse has no episode", () => {
    expect(map.reverse(500, undefined)).toEqual({
      kind: "resolved",
      value: { tmdbId: 999, tmdbKind: "movie", tmdbSeason: null, tmdbEpisode: 0 },
    });
  });

  it("unknown anilist id → miss", () => {
    expect(map.reverse(123456, 1)).toEqual({ kind: "miss" });
  });
});

describe("bundled seed (real Fribb data)", () => {
  it("resolves the Attack on Titan S3 split from the shipped seed", () => {
    // Anchors against real data; regenerating the seed shouldn't move these.
    expect(defaultAnimap.forward(1429, "tv", 3, 15)).toEqual({
      kind: "resolved",
      value: { anilistId: 104578, localEpisode: 3 },
    });
  });

  it("reverse-resolves a known AniList id to its TMDB show", () => {
    const r = defaultAnimap.reverse(16498, 1); // AoT S1 ep1
    expect(r).toEqual({
      kind: "resolved",
      value: { tmdbId: 1429, tmdbKind: "tv", tmdbSeason: 1, tmdbEpisode: 1 },
    });
  });
});
