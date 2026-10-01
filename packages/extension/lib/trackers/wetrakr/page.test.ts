import { describe, expect, it } from "vitest";
import { parseWetrakrPath } from "./page";

describe("parseWetrakrPath", () => {
  it("reads movie, show, season, and episode pages", () => {
    expect(parseWetrakrPath("/movies/126")).toEqual({ type: "movie", id: 126 });
    expect(parseWetrakrPath("/shows/1391953/seasons/2")).toEqual({
      type: "show",
      id: 1391953,
      season: 2,
    });
    expect(parseWetrakrPath("/shows/1391953/seasons/2/episodes/5/comments")).toEqual({
      type: "show",
      id: 1391953,
      season: 2,
      episode: 5,
    });
  });

  it("ignores other pages", () => {
    expect(parseWetrakrPath("/movies")).toBeNull();
    expect(parseWetrakrPath("/lists/12")).toBeNull();
  });
});
