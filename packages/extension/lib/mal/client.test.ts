import { describe, expect, it } from "vitest";
import { malCacheKey, nodeToIdentity, pickBest, toCourEntry } from "./client";
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
