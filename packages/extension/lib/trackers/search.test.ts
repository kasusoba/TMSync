import { describe, expect, it } from "vitest";
import { pickMedia } from "./search";
import { resolutionCacheKey } from "./trakt/util";
import type { SearchOption } from "./types";

describe("pickMedia", () => {
  const show: SearchOption = {
    tracker: "trakt",
    id: 1,
    mediaType: "show",
    title: "Frieren",
    year: 2023,
    ids: { tmdb: 209867, imdb: "tt22248376", tvdb: 424536 },
  };

  it("carries the ids of a Trakt pick, so the crosswalk and Simkl can match by id", () => {
    expect(pickMedia(show, 1, 5)).toEqual({
      mediaType: "show",
      title: "Frieren",
      year: 2023,
      season: 1,
      episode: 5,
      ids: { tmdb: 209867, imdb: "tt22248376", tvdb: 424536 },
    });
  });

  it("keys the Trakt correction on the id, the same key resolve reads", () => {
    expect(resolutionCacheKey(pickMedia(show, 1, 5))).toBe("show:tmdb:209867");
  });

  it("builds a cour pick with its own id and no season", () => {
    const cour: SearchOption = {
      tracker: "anilist",
      id: 154587,
      mediaType: "show",
      title: "Frieren",
      ids: { anilist: 154587 },
    };
    expect(pickMedia(cour, undefined, 3)).toEqual({
      mediaType: "show",
      title: "Frieren",
      ids: { anilist: 154587 },
      episode: 3,
    });
  });

  it("builds a movie without numbering and skips missing ids", () => {
    const movie: SearchOption = {
      tracker: "mal",
      id: 28851,
      mediaType: "movie",
      title: "A Silent Voice",
      year: 2016,
      ids: { mal: 28851, tmdb: undefined },
    };
    expect(pickMedia(movie, 1, 2)).toEqual({
      mediaType: "movie",
      title: "A Silent Voice",
      year: 2016,
      ids: { mal: 28851 },
    });
  });

  it("leaves ids out when the tracker gave none", () => {
    const bare: SearchOption = { tracker: "trakt", id: 3, mediaType: "movie", title: "X", ids: {} };
    expect(pickMedia(bare)).not.toHaveProperty("ids");
  });
});
