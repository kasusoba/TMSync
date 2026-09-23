import { malCorrections, malResolutionCache } from "@/lib/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import {
  correctionFor,
  getAnime,
  liveMisses,
  malCacheKey,
  nodeToIdentity,
  pickBest,
  toCourEntry,
} from "./client";
import type { MalAnimeNode } from "./types";

const node = (n: Partial<MalAnimeNode> & { id: number; title: string }): MalAnimeNode => ({
  media_type: "tv",
  ...n,
});

describe("nodeToIdentity", () => {
  it("prefers the English title, reads the year, and maps 0 episodes to unknown", () => {
    expect(
      nodeToIdentity(
        node({
          id: 38524,
          title: "Shingeki no Kyojin Season 3 Part 2",
          alternative_titles: { en: "Attack on Titan Season 3 Part 2" },
          start_date: "2019-04-29",
          num_episodes: 10,
        }),
      ),
    ).toEqual({ id: 38524, title: "Attack on Titan Season 3 Part 2", year: 2019, episodes: 10 });
    expect(nodeToIdentity(node({ id: 1, title: "Ongoing", num_episodes: 0 }))).toEqual({
      id: 1,
      title: "Ongoing",
      year: undefined,
      episodes: null,
    });
  });
});

describe("pickBest", () => {
  const hits = [
    node({ id: 1, title: "Frieren Movie", media_type: "movie", start_date: "2023-01-01" }),
    node({ id: 2, title: "Sousou no Frieren 2nd Season", start_date: "2026-01-10" }),
    node({
      id: 3,
      title: "Sousou no Frieren",
      alternative_titles: { en: "Frieren: Beyond Journey's End", synonyms: ["Frieren"] },
      start_date: "2023-09-29",
    }),
  ];

  it("skips movies and prefers an exact title or synonym match", () => {
    expect(pickBest(hits, "Frieren")?.id).toBe(3);
    expect(pickBest(hits, "frieren: beyond journey's end")?.id).toBe(3);
  });

  it("uses the scraped year to choose between series", () => {
    expect(pickBest(hits, "Sousou no Frieren", 2026)?.id).toBe(2);
  });

  it("falls back to MAL's top series hit", () => {
    expect(pickBest(hits, "something else")?.id).toBe(2);
    expect(pickBest([hits[0] as MalAnimeNode], "x")).toBeUndefined();
  });
});

describe("toCourEntry", () => {
  it("maps MAL statuses onto the cour planner's", () => {
    expect(toCourEntry({ status: "watching", num_episodes_watched: 4 })).toEqual({
      status: "CURRENT",
      progress: 4,
      repeat: 0,
    });
    expect(
      toCourEntry({ status: "completed", num_episodes_watched: 12, num_times_rewatched: 2 }),
    ).toEqual({ status: "COMPLETED", progress: 12, repeat: 2 });
    expect(toCourEntry({ status: "completed", is_rewatching: true }).status).toBe("REPEATING");
    expect(toCourEntry({ status: "on_hold" }).status).toBe("PAUSED");
    expect(toCourEntry({ status: "dropped" }).status).toBe("DROPPED");
    expect(toCourEntry({ status: "plan_to_watch" }).status).toBe("PLANNING");
    expect(toCourEntry({}).status).toBeNull();
  });
});

describe("malCacheKey", () => {
  it("keys by native id, then AniList id, then title and year", () => {
    expect(malCacheKey({ mediaType: "show", title: "X", ids: { mal: 5 } })).toBe("id:5");
    expect(malCacheKey({ mediaType: "show", title: "X", ids: { anilist: 7 } })).toBe("al:7");
    expect(malCacheKey({ mediaType: "show", title: " Frieren ", year: 2023 })).toBe("frieren:2023");
    expect(malCacheKey({ mediaType: "show", title: "Frieren", year: 2023, season: 2 })).toBe(
      "frieren:2023:s2",
    );
  });
});

describe("liveMisses", () => {
  it("drops misses older than the hour, so the cache does not grow forever", () => {
    const now = 10 * 60 * 60 * 1000;
    expect(liveMisses({ old: now - 2 * 60 * 60 * 1000, recent: now - 60_000 }, now)).toEqual({
      recent: now - 60_000,
    });
  });
});

describe("correctionFor", () => {
  beforeEach(() => fakeBrowser.reset());
  const pinned = { id: 7, title: "Pinned", year: 2020, episodes: 12 };

  it("finds a title pin when the review path added derived ids to the media", async () => {
    await malCorrections.setValue({ "show:2020:s2": pinned });
    const media = { mediaType: "show" as const, title: "Show", year: 2020, season: 2 };
    expect(await correctionFor(media)).toEqual({ identity: pinned });
    expect(await correctionFor({ ...media, ids: { anilist: 1, mal: 99 } })).toEqual({
      identity: pinned,
    });
  });

  it("skips the title key when the media has a tmdb id", async () => {
    await malCorrections.setValue({ "show:2020": pinned });
    const media = { mediaType: "show" as const, title: "Show", year: 2020 };
    expect(await correctionFor({ ...media, ids: { tmdb: 5, mal: 99 } })).toBeUndefined();
  });

  it("prefers the id pin over the title pin", async () => {
    const other = { ...pinned, id: 8 };
    await malCorrections.setValue({ "id:99": other, "show:2020": pinned });
    const media = { mediaType: "show" as const, title: "Show", year: 2020, ids: { mal: 99 } };
    expect(await correctionFor(media)).toEqual({ identity: other });
  });
});

describe("getAnime", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(true);
  });

  it("serves a cached entry without calling MAL", async () => {
    const identity = { id: 52991, title: "Frieren", year: 2023, episodes: 28 };
    await malResolutionCache.setValue({ "id:52991": { ...identity, at: 0 } });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await getAnime(52991)).toEqual(identity);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
