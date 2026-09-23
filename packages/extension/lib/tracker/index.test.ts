import type { ParsedMedia } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { type Tracker, getAdapter, inferNativeTracker, routeTracker } from "./index";

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
    expect(routeTracker("mal", "movie")).toBe("trakt");
    expect(routeTracker("trakt", "movie")).toBe("trakt");
  });

  it("keeps a movie on a tracker that takes movies (Simkl)", () => {
    expect(routeTracker("simkl", "movie")).toBe("simkl");
  });

  it("leaves shows on the recipe's tracker (series → AniList stays)", () => {
    expect(routeTracker("anilist", "show")).toBe("anilist");
    expect(routeTracker("trakt", "show")).toBe("trakt");
  });
});

describe("inferNativeTracker (multi-track — which numbering the page speaks)", () => {
  it("TMDB seasoning (a tmdb id or a season) ⇒ Trakt native", () => {
    expect(
      inferNativeTracker({
        mediaType: "show",
        title: "x",
        ids: { tmdb: 1429 },
        season: 3,
        episode: 15,
      }),
    ).toBe("trakt");
    expect(inferNativeTracker({ mediaType: "show", title: "x", season: 1, episode: 2 })).toBe(
      "trakt",
    );
    expect(inferNativeTracker({ mediaType: "movie", title: "Dune", ids: { tmdb: 438631 } })).toBe(
      "trakt",
    );
  });

  it("an imdb id (also Trakt-native) ⇒ Trakt native", () => {
    expect(inferNativeTracker({ mediaType: "movie", title: "x", ids: { imdb: "tt1160419" } })).toBe(
      "trakt",
    );
  });

  it("a bare linear episode (no Trakt-native id, no season) ⇒ AniList native", () => {
    expect(inferNativeTracker({ mediaType: "show", title: "Frieren", episode: 3 })).toBe("anilist");
  });

  it("a DISABLED tracker can't be native — AniList-only on a TMDB/seasoned page ⇒ AniList", () => {
    // The aether case: recipe scrapes tmdb + season but the user enabled ONLY AniList.
    // Field-wise it looks Trakt-native, but Trakt is off, so AniList records directly
    // (scraped episode) instead of being forced through the crosswalk.
    const media = {
      mediaType: "show" as const,
      title: "Akame ga Kill!",
      ids: { tmdb: 60564 },
      season: 1,
      episode: 3,
    };
    expect(inferNativeTracker(media)).toBe("trakt"); // no enabled set ⇒ pure field answer
    expect(inferNativeTracker(media, ["anilist"])).toBe("anilist"); // Trakt off ⇒ AniList native
    expect(inferNativeTracker(media, ["trakt", "anilist"])).toBe("trakt"); // both ⇒ Trakt native
  });
});

describe("inferNativeTracker with Simkl (passthrough)", () => {
  const anime: ParsedMedia = {
    mediaType: "show",
    title: "Frieren",
    ids: { anilist: 1 },
    episode: 3,
  };
  const tv: ParsedMedia = {
    mediaType: "show",
    title: "x",
    ids: { tmdb: 5 },
    season: 1,
    episode: 2,
  };

  it("is never the anchor while another tracker is on", () => {
    expect(inferNativeTracker(tv, ["simkl", "trakt"])).toBe("trakt");
    expect(inferNativeTracker(anime, ["simkl", "anilist"])).toBe("anilist");
    expect(inferNativeTracker(anime, ["simkl", "trakt"])).toBe("trakt");
  });

  it("is native when it stands alone", () => {
    expect(inferNativeTracker(tv, ["simkl"])).toBe("simkl");
    expect(inferNativeTracker(anime, ["simkl"])).toBe("simkl");
  });
});

describe("inferNativeTracker's choice", () => {
  const tv: ParsedMedia = { mediaType: "show", title: "The Bear", season: 2, episode: 3 };
  const anime: ParsedMedia = { mediaType: "show", title: "Frieren", episode: 3 };

  it("is always one of the enabled trackers", () => {
    for (const enabled of [["mal"], ["anilist", "simkl"], ["trakt"], ["simkl"]] as Tracker[][]) {
      expect(enabled).toContain(inferNativeTracker(tv, enabled));
      expect(enabled).toContain(inferNativeTracker(anime, enabled));
    }
  });

  it("treats an empty enabled list like no list (no hardcoded default)", () => {
    expect(inferNativeTracker(tv, [])).toBe(inferNativeTracker(tv));
    expect(inferNativeTracker(anime, [])).toBe(inferNativeTracker(anime));
  });
});
