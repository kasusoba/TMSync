import type { ParsedMedia } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import type { TrackedItem } from "../tracker/types";
import { Animap, type AnimapRow } from "./index";
import { deriveMedia } from "./derive";

const rows: AnimapRow[] = [
  { a: 99147, t: 1429, k: "tv", s: 3, o: null }, // AoT S3 part 1
  { a: 104578, t: 1429, k: "tv", s: 3, o: 12 }, // AoT S3 part 2
];
const map = new Animap(rows);

const traktItem: TrackedItem = { tracker: "trakt", mediaType: "show", id: 1, title: "AoT" };
const anilistItem: TrackedItem = {
  tracker: "anilist",
  mediaType: "show",
  id: 104578,
  title: "AoT S3 P2",
  episodes: 10,
};

describe("deriveMedia — forward (TMDB-native → AniList)", () => {
  it("derives the AniList entry + local episode from tmdb season/episode", () => {
    const media: ParsedMedia = { mediaType: "show", title: "AoT", tmdbId: 1429, season: 3, episode: 15 };
    const out = deriveMedia("anilist", media, traktItem, map);
    expect(out).toEqual({
      kind: "resolved",
      anilistId: 104578,
      media: { mediaType: "show", title: "AoT", tmdbId: 1429, season: undefined, episode: 3 },
    });
  });

  it("misses (skips AniList) when there's no scraped tmdbId", () => {
    const media: ParsedMedia = { mediaType: "show", title: "AoT", season: 3, episode: 15 };
    expect(deriveMedia("anilist", media, traktItem, map)).toEqual({ kind: "miss" });
  });

  it("propagates ambiguous from the crosswalk (no season on a multi-cour show)", () => {
    const media: ParsedMedia = { mediaType: "show", title: "AoT", tmdbId: 1429, episode: 15 };
    expect(deriveMedia("anilist", media, traktItem, map)).toEqual({ kind: "ambiguous" });
  });
});

describe("deriveMedia — reverse (AniList-native → Trakt)", () => {
  it("derives the tmdb id + season + tmdb episode from the AniList entry", () => {
    const media: ParsedMedia = { mediaType: "show", title: "AoT", episode: 3 };
    const out = deriveMedia("trakt", media, anilistItem, map);
    expect(out).toEqual({
      kind: "resolved",
      media: { mediaType: "show", title: "AoT", tmdbId: 1429, season: 3, episode: 15 },
    });
  });

  it("misses when the native item isn't an AniList entry (no id to reverse)", () => {
    const media: ParsedMedia = { mediaType: "show", title: "AoT", episode: 3 };
    expect(deriveMedia("trakt", media, traktItem, map)).toEqual({ kind: "miss" });
  });
});

describe("deriveMedia — movies deferred", () => {
  it("skips movies (native tracker still records them)", () => {
    const media: ParsedMedia = { mediaType: "movie", title: "A Silent Voice", tmdbId: 378064 };
    expect(deriveMedia("anilist", media, traktItem, map)).toEqual({ kind: "miss" });
  });
});
