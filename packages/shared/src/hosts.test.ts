import { describe, expect, it } from "vitest";
import {
  escapeRegex,
  hostOf,
  hostText,
  normalizeHost,
  patternHosts,
  patternPath,
  recipeHosts,
  withPatternHosts,
  withRecipeHosts,
} from "./hosts";
import type { Recipe } from "./schema";

function recipe(match: Recipe["match"]): Recipe {
  return {
    id: "test",
    schemaVersion: 2,
    name: "Test",
    match,
    mediaType: "auto",
    tracker: "trakt",
    video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
    extract: { title: { source: "title" } },
  };
}

describe("hostText / normalizeHost / hostOf", () => {
  it("keeps www in the storage form, drops it in the comparison form", () => {
    expect(hostText("WWW.Cineby.At")).toBe("www.cineby.at");
    expect(normalizeHost("WWW.Cineby.At")).toBe("cineby.at");
    expect(hostOf("https://www.cineby.at/movie/42")).toBe("cineby.at");
  });

  it("returns an empty string for an unparseable url", () => {
    expect(hostOf("not a url")).toBe("");
  });
});

describe("patternHosts / patternPath", () => {
  it("reads a single escaped host anchor", () => {
    expect(patternHosts("cineby\\.at/movie")).toEqual(["cineby.at"]);
    expect(patternPath("cineby\\.at/movie")).toBe("/movie");
  });

  it("reads an alternation of hosts", () => {
    expect(patternHosts("(?:cineby\\.at|cineby\\.app)/movie")).toEqual(["cineby.at", "cineby.app"]);
    expect(patternPath("(?:cineby\\.at|cineby\\.app)/movie")).toBe("/movie");
  });

  it("reads a host-only pattern", () => {
    expect(patternHosts("stream\\.tld")).toEqual(["stream.tld"]);
    expect(patternPath("stream\\.tld")).toBe("");
  });

  it("finds no host in a path-only or wildcard pattern", () => {
    expect(patternHosts("/movie/")).toEqual([]);
    expect(patternHosts(".*")).toEqual([]);
    expect(patternPath("/movie/")).toBe("/movie/");
  });
});

describe("withPatternHosts", () => {
  it("re-anchors a pattern to one host", () => {
    expect(withPatternHosts("/movie", ["cineby.at"])).toBe("cineby\\.at/movie");
  });

  it("re-anchors to several hosts as an alternation", () => {
    expect(withPatternHosts("cineby\\.at/movie", ["cineby.at", "cineby.app"])).toBe(
      "(?:cineby\\.at|cineby\\.app)/movie",
    );
  });

  it("strips the anchor when given no hosts", () => {
    expect(withPatternHosts("cineby\\.at/movie", [])).toBe("/movie");
  });
});

describe("recipeHosts", () => {
  it("prefers the hostnames list, keeping each host as stored", () => {
    const r = recipe({ urlPattern: "/movie", hostnames: ["Cineby.at", "www.cineby.app"] });
    expect(recipeHosts(r)).toEqual(["cineby.at", "www.cineby.app"]);
  });

  it("falls back to the pattern anchor", () => {
    expect(recipeHosts(recipe({ urlPattern: "cineby\\.at/movie" }))).toEqual(["cineby.at"]);
  });

  it("is empty for a host-free recipe", () => {
    expect(recipeHosts(recipe({ urlPattern: "/movie" }))).toEqual([]);
  });
});

describe("withRecipeHosts", () => {
  it("moves the host out of the pattern and into hostnames", () => {
    const moved = withRecipeHosts(recipe({ urlPattern: "cineby\\.at/movie" }), [
      "cineby.at",
      "cineby.app",
    ]);
    expect(moved.match.hostnames).toEqual(["cineby.at", "cineby.app"]);
    expect(moved.match.urlPattern).toBe("/movie");
  });

  it("drops the list when given no hosts", () => {
    const freed = withRecipeHosts(recipe({ urlPattern: "cineby\\.at/movie" }), []);
    expect(freed.match.hostnames).toBeUndefined();
    expect(freed.match.urlPattern).toBe("/movie");
  });
});

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("a.b+c")).toBe("a\\.b\\+c");
  });
});
