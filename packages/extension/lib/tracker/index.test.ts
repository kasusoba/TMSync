import type { ParsedMedia } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { getAdapter, routeTracker } from "./index";

describe("getAdapter", () => {
  it("routes each tracker to its adapter", () => {
    expect(getAdapter("trakt").tracker).toBe("trakt");
    expect(getAdapter("anilist").tracker).toBe("anilist");
  });

  it("exposes tracker-specific rating levels (no fixed set)", () => {
    const movie: ParsedMedia = { mediaType: "movie", title: "Dune" };
    const episode: ParsedMedia = { mediaType: "show", title: "Frieren", season: 1, episode: 3 };
    // Trakt: movie vs show/season/episode; AniList: a single cour entry.
    expect(getAdapter("trakt").ratingLevels(movie)).toEqual(["movie"]);
    expect(getAdapter("trakt").ratingLevels(episode)).toEqual(["episode", "season", "show"]);
    expect(getAdapter("anilist").ratingLevels(episode)).toEqual(["cour"]);
  });
});

describe("routeTracker (route by type — constraint #1)", () => {
  it("sends a movie to Trakt even on an anilist site (anime movies → Trakt)", () => {
    expect(routeTracker("anilist", "movie")).toBe("trakt");
    expect(routeTracker("trakt", "movie")).toBe("trakt");
  });

  it("leaves shows on the recipe's tracker (series → AniList stays)", () => {
    expect(routeTracker("anilist", "show")).toBe("anilist");
    expect(routeTracker("trakt", "show")).toBe("trakt");
  });
});
