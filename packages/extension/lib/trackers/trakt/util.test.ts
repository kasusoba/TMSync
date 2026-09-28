import type { ParsedMedia } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import type { ResolvedIdentity, TraktSearchOption, TraktTokens } from "./types";
import {
  buildRatingBody,
  buildScrobbleBody,
  isTokenExpired,
  pickedIdentity,
  pickedMedia,
  resolutionCacheKey,
  reviewKey,
} from "./util";

describe("buildScrobbleBody", () => {
  const movieId: ResolvedIdentity = { mediaType: "movie", traktId: 28, title: "Neon Tides" };
  const showId: ResolvedIdentity = { mediaType: "show", traktId: 1, title: "The Pixel Frontier" };

  it("builds a movie body", () => {
    const media: ParsedMedia = { mediaType: "movie", title: "Neon Tides" };
    expect(buildScrobbleBody(movieId, media, 42.5)).toEqual({
      movie: { ids: { trakt: 28 } },
      progress: 42.5,
    });
  });

  it("builds an episode body with show + season/number", () => {
    const media: ParsedMedia = { mediaType: "show", title: "X", season: 2, episode: 4 };
    expect(buildScrobbleBody(showId, media, 99.9)).toEqual({
      show: { ids: { trakt: 1 } },
      episode: { season: 2, number: 4 },
      progress: 99.9,
    });
  });

  it("returns null for a show missing season/episode", () => {
    const media: ParsedMedia = { mediaType: "show", title: "X", season: 2 };
    expect(buildScrobbleBody(showId, media, 50)).toBeNull();
  });

  it("clamps progress in the built body", () => {
    const media: ParsedMedia = { mediaType: "movie", title: "X" };
    expect(buildScrobbleBody(movieId, media, 250)?.progress).toBe(100);
  });
});

describe("resolutionCacheKey", () => {
  it("is identical across episodes of the same show", () => {
    const a: ParsedMedia = {
      mediaType: "show",
      title: "The Show",
      year: 2020,
      season: 1,
      episode: 1,
    };
    const b: ParsedMedia = {
      mediaType: "show",
      title: "the show ",
      year: 2020,
      season: 3,
      episode: 9,
    };
    expect(resolutionCacheKey(a)).toBe(resolutionCacheKey(b));
    expect(resolutionCacheKey(a)).toBe("show:the show:2020");
  });

  it("distinguishes movie vs show and year", () => {
    const movie: ParsedMedia = { mediaType: "movie", title: "Dune", year: 2021 };
    expect(resolutionCacheKey(movie)).toBe("movie:dune:2021");
  });

  it("keys on the TMDB id when present (independent of the scraped title)", () => {
    const a: ParsedMedia = { mediaType: "movie", title: "Dune", year: 2021, ids: { tmdb: 438631 } };
    const b: ParsedMedia = {
      mediaType: "movie",
      title: "completely different",
      ids: { tmdb: 438631 },
    };
    expect(resolutionCacheKey(a)).toBe("movie:tmdb:438631");
    expect(resolutionCacheKey(a)).toBe(resolutionCacheKey(b));
  });

  it("keys on an imdb id (namespace-tagged, so it can't collide with a tmdb id)", () => {
    const m: ParsedMedia = { mediaType: "movie", title: "Heat", ids: { imdb: "tt0113277" } };
    expect(resolutionCacheKey(m)).toBe("movie:imdb:tt0113277");
  });
});

describe("buildRatingBody", () => {
  const movie: ResolvedIdentity = { mediaType: "movie", traktId: 28, title: "Neon Tides" };
  const show: ResolvedIdentity = { mediaType: "show", traktId: 1, title: "The Pixel Frontier" };

  it("rates a movie", () => {
    expect(buildRatingBody(movie, "movie", undefined, undefined, 9)).toEqual({
      movies: [{ ids: { trakt: 28 }, rating: 9 }],
    });
  });

  it("rates a whole show", () => {
    expect(buildRatingBody(show, "show", 2, 4, 8)).toEqual({
      shows: [{ ids: { trakt: 1 }, rating: 8 }],
    });
  });

  it("rates a season by number nested under the show", () => {
    expect(buildRatingBody(show, "season", 2, 4, 7)).toEqual({
      shows: [{ ids: { trakt: 1 }, seasons: [{ number: 2, rating: 7 }] }],
    });
  });

  it("rates an episode by number nested under season + show", () => {
    expect(buildRatingBody(show, "episode", 2, 4, 10)).toEqual({
      shows: [
        { ids: { trakt: 1 }, seasons: [{ number: 2, episodes: [{ number: 4, rating: 10 }] }] },
      ],
    });
  });

  it("omits rating for the remove endpoint", () => {
    expect(buildRatingBody(show, "episode", 2, 4)).toEqual({
      shows: [{ ids: { trakt: 1 }, seasons: [{ number: 2, episodes: [{ number: 4 }] }] }],
    });
  });

  it("returns null when a season/episode level lacks its number(s)", () => {
    expect(buildRatingBody(show, "season", undefined, undefined, 7)).toBeNull();
    expect(buildRatingBody(show, "episode", 2, undefined, 7)).toBeNull();
  });
});

describe("reviewKey", () => {
  const show: ResolvedIdentity = { mediaType: "show", traktId: 1, title: "X" };
  it("separates levels and includes season/episode where relevant", () => {
    expect(reviewKey(show, "show", 2, 4)).toBe("show:1::");
    expect(reviewKey(show, "season", 2, 4)).toBe("season:1:2:");
    expect(reviewKey(show, "episode", 2, 4)).toBe("episode:1:2:4");
  });
});

describe("isTokenExpired", () => {
  const tokens: TraktTokens = {
    access_token: "a",
    refresh_token: "r",
    token_type: "bearer",
    expires_in: 1000,
    created_at: 10_000,
    scope: "public",
  };

  it("is false well before expiry", () => {
    expect(isTokenExpired(tokens, 10_500)).toBe(false);
  });

  it("is true within the skew window", () => {
    expect(isTokenExpired(tokens, 10_950)).toBe(true); // 10000+1000-60 = 10940
  });

  it("is true after expiry", () => {
    expect(isTokenExpired(tokens, 11_500)).toBe(true);
  });
});

describe("pickedMedia", () => {
  const show: TraktSearchOption = {
    type: "show",
    traktId: 1,
    title: "Frieren",
    year: 2023,
    ids: { tmdb: 209867, imdb: "tt22248376", tvdb: 424536 },
  };

  it("carries the ids Trakt knows, so the crosswalk and Simkl can match by id", () => {
    expect(pickedMedia(show, 1, 5)).toEqual({
      mediaType: "show",
      title: "Frieren",
      year: 2023,
      season: 1,
      episode: 5,
      ids: { tmdb: 209867, imdb: "tt22248376", tvdb: 424536 },
    });
  });

  it("keys the Trakt correction on the id, the same key resolve reads", () => {
    expect(resolutionCacheKey(pickedMedia(show, 1, 5))).toBe("show:tmdb:209867");
  });

  it("builds a movie without numbering and skips missing ids", () => {
    const movie: TraktSearchOption = {
      type: "movie",
      traktId: 2,
      title: "Dune",
      year: 2021,
      ids: { imdb: "tt1160419" },
    };
    expect(pickedMedia(movie)).toEqual({
      mediaType: "movie",
      title: "Dune",
      year: 2021,
      ids: { imdb: "tt1160419" },
    });
  });

  it("leaves ids out when Trakt gave none", () => {
    const bare: TraktSearchOption = { type: "movie", traktId: 3, title: "X" };
    expect(pickedMedia(bare)).not.toHaveProperty("ids");
  });
});

describe("pickedIdentity", () => {
  it("maps a search result to the Trakt identity", () => {
    expect(
      pickedIdentity({ type: "show", traktId: 7, title: "T", year: 2020, ids: { tmdb: 1 } }),
    ).toEqual({ mediaType: "show", traktId: 7, title: "T", year: 2020 });
  });
});
