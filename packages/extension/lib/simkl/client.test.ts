import type { ParsedMedia } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { lockWait, matchFrom, scrobbleBody, simklIds, simklKey, simklKind } from "./client";

const show: ParsedMedia = {
  mediaType: "show",
  title: "Attack on Titan",
  year: 2013,
  ids: { tmdb: 1429 },
  season: 3,
  episode: 13,
};
const anime: ParsedMedia = {
  mediaType: "show",
  title: "Frieren",
  ids: { anilist: 154587, mal: 52991, tmdb: 209867 },
  episode: 3,
};

describe("simklKind", () => {
  it("sends a season under show, a bare episode under anime", () => {
    expect(simklKind(show)).toBe("show");
    expect(simklKind(anime)).toBe("anime");
    expect(simklKind({ mediaType: "movie", title: "Dune" })).toBe("movie");
  });
});

describe("simklIds", () => {
  it("sends ids as strings and adds a known Simkl id", () => {
    expect(simklIds(show, 39687)).toEqual({ simkl: 39687, tmdb: "1429" });
  });

  it("keeps a TMDB show id off an anime body when a cour id exists", () => {
    expect(simklIds(anime)).toEqual({ mal: "52991", anilist: "154587" });
    expect(simklIds({ mediaType: "show", title: "x", ids: { tmdb: 5 }, episode: 1 })).toEqual({
      tmdb: "5",
    });
  });
});

describe("scrobbleBody", () => {
  it("builds a show body with season + number", () => {
    expect(scrobbleBody(show, 42.555)).toEqual({
      progress: 42.56,
      show: { title: "Attack on Titan", year: 2013, ids: { tmdb: "1429" } },
      episode: { season: 3, number: 13 },
    });
  });

  it("builds an anime body with a linear episode", () => {
    expect(scrobbleBody(anime, 90)).toEqual({
      progress: 90,
      anime: { title: "Frieren", ids: { mal: "52991", anilist: "154587" } },
      episode: { number: 3 },
    });
  });

  it("refuses an episode-less show, and clamps progress", () => {
    expect(scrobbleBody({ ...show, episode: undefined }, 50)).toBeNull();
    expect(scrobbleBody({ mediaType: "movie", title: "Dune" }, 140)).toEqual({
      progress: 100,
      movie: { title: "Dune", ids: {} },
    });
  });
});

describe("simklKey", () => {
  it("keys a show per season, so each anime season caches its own match", () => {
    expect(simklKey(show)).toBe("show:tmdb:1429:s3");
    expect(simklKey({ ...show, season: 1 })).not.toBe(simklKey(show));
    expect(simklKey({ mediaType: "movie", title: " Dune ", year: 2021 })).toBe("movie:t:dune:2021");
  });

  it("drops the season for a whole-show key (Simkl rates a western show whole)", () => {
    expect(simklKey(show, false)).toBe("show:tmdb:1429");
    expect(simklKey({ ...show, season: 1 }, false)).toBe(simklKey(show, false));
  });

  it("keys an anime item on its cour id before a TMDB show id", () => {
    const cour = {
      mediaType: "show" as const,
      title: "AoT",
      episode: 3,
      ids: { tmdb: 1429, mal: 16498 },
    };
    expect(simklKey(cour)).toBe("anime:mal:16498");
  });
});

describe("matchFrom", () => {
  it("reads the Simkl id, section, and title from a scrobble response", () => {
    expect(
      matchFrom({ action: "start", anime: { title: "Frieren", year: 2023, ids: { simkl: 9 } } }),
    ).toEqual({ id: 9, section: "anime", title: "Frieren", year: 2023 });
    expect(matchFrom({ show: { title: "x", ids: { simkl_id: 4 } } })?.section).toBe("tv");
    expect(matchFrom({ action: "start" })).toBeNull();
  });
});

describe("lockWait", () => {
  it("waits out the rest of the 20 s scrobble lock", () => {
    expect(lockWait(1_000, 6_000)).toBe(15_000);
    expect(lockWait(1_000, 30_000)).toBe(0);
  });
});
