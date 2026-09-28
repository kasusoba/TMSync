import { describe, expect, it } from "vitest";
import { Animap, type AnimapRow } from "./index";
import { withOverrides } from "./overrides";

const rows: AnimapRow[] = [
  { a: 16498, m: 16498, t: 1429, k: "tv", s: 1, o: null },
  { a: 99147, m: 35760, t: 1429, k: "tv", s: 3, o: null },
  { a: 104578, m: 38524, t: 1429, k: "tv", s: 3, o: 12 },
  { a: 30, m: 300, t: 50, k: "tv", s: 1, o: null },
];
const none = { forward: {}, reverse: {} };

describe("withOverrides", () => {
  it("keeps the rows as they are with no pins", () => {
    expect(withOverrides(rows, none)).toEqual(rows);
  });

  it("a forward pin makes the season one entry, and moves the entry there", () => {
    const map = new Animap(withOverrides(rows, { ...none, forward: { "1429:3": 30 } }));
    expect(map.forward(1429, "tv", 3, 20)).toEqual({
      kind: "resolved",
      value: { anilistId: 30, malId: 300, localEpisode: 20 },
    });
    // The pinned entry left its Fribb place.
    expect(map.has(50, "tv")).toBe(false);
    expect(map.reverse("anilist", 30, 2)).toMatchObject({
      kind: "resolved",
      value: { tmdbId: 1429, tmdbSeason: 3, tmdbEpisode: 2 },
    });
  });

  it("'not on AniList' drops the season for every cour tracker", () => {
    const map = new Animap(withOverrides(rows, { ...none, forward: { "1429:3": null } }));
    expect(map.forward(1429, "tv", 3, 1).kind).toBe("miss");
    expect(map.forward(1429, "tv", 1, 1).kind).toBe("resolved");
  });

  it("a reverse pin sends the entry to the pinned season", () => {
    const map = new Animap(
      withOverrides(rows, { ...none, reverse: { 30: { tmdbId: 777, season: 2 } } }),
    );
    expect(map.reverse("anilist", 30, 5)).toMatchObject({
      kind: "resolved",
      value: { tmdbId: 777, tmdbSeason: 2, tmdbEpisode: 5 },
    });
    expect(map.malForAnilist(30)).toBe(300);
  });

  it("a MAL pin sets the season's MAL id only when the season is one row", () => {
    const one = new Animap(withOverrides(rows, { ...none, forwardMal: { "1429:1": 1 } }));
    expect(one.malForAnilist(16498)).toBe(1);
    const split = new Animap(withOverrides(rows, { ...none, forwardMal: { "1429:3": 2 } }));
    expect(split.malForAnilist(99147)).toBeUndefined();
    expect(split.malForAnilist(104578)).toBeUndefined();
  });

  it("ignores a pin without a season (movie or show is unknown)", () => {
    expect(withOverrides(rows, { ...none, forward: { "50:": 1 } })).toEqual(rows);
  });
});
