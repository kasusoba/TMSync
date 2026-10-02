import { describe, expect, it } from "vitest";
import {
  escapeRegex,
  hostOf,
  hostText,
  normalizeHost,
  patternHosts,
  patternPath,
  recipeHosts,
  siteLabel,
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
    video: { selector: "video", frame: "auto" },
    extract: { title: { source: "title" } },
  };
}

describe("hostText / normalizeHost / hostOf", () => {
  it("keeps www in the storage form, drops it in the comparison form", () => {
    expect(hostText("WWW.Examplemovies.At")).toBe("www.examplemovies.at");
    expect(normalizeHost("WWW.Examplemovies.At")).toBe("examplemovies.at");
    expect(hostOf("https://www.examplemovies.at/movie/42")).toBe("examplemovies.at");
  });

  it("returns an empty string for an unparseable url", () => {
    expect(hostOf("not a url")).toBe("");
  });
});

describe("patternHosts / patternPath", () => {
  it("reads a single escaped host anchor", () => {
    expect(patternHosts("examplemovies\\.at/movie")).toEqual(["examplemovies.at"]);
    expect(patternPath("examplemovies\\.at/movie")).toBe("/movie");
  });

  it("reads an alternation of hosts", () => {
    expect(patternHosts("(?:examplemovies\\.at|examplemovies\\.app)/movie")).toEqual([
      "examplemovies.at",
      "examplemovies.app",
    ]);
    expect(patternPath("(?:examplemovies\\.at|examplemovies\\.app)/movie")).toBe("/movie");
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
    expect(withPatternHosts("/movie", ["examplemovies.at"])).toBe("examplemovies\\.at/movie");
  });

  it("re-anchors to several hosts as an alternation", () => {
    expect(
      withPatternHosts("examplemovies\\.at/movie", ["examplemovies.at", "examplemovies.app"]),
    ).toBe("(?:examplemovies\\.at|examplemovies\\.app)/movie");
  });

  it("strips the anchor when given no hosts", () => {
    expect(withPatternHosts("examplemovies\\.at/movie", [])).toBe("/movie");
  });
});

describe("recipeHosts", () => {
  it("prefers the hostnames list, keeping each host as stored", () => {
    const r = recipe({
      urlPattern: "/movie",
      hostnames: ["Examplemovies.at", "www.examplemovies.app"],
    });
    expect(recipeHosts(r)).toEqual(["examplemovies.at", "www.examplemovies.app"]);
  });

  it("falls back to the pattern anchor", () => {
    expect(recipeHosts(recipe({ urlPattern: "examplemovies\\.at/movie" }))).toEqual([
      "examplemovies.at",
    ]);
  });

  it("is empty for a host-free recipe", () => {
    expect(recipeHosts(recipe({ urlPattern: "/movie" }))).toEqual([]);
  });
});

describe("withRecipeHosts", () => {
  it("moves the host out of the pattern and into hostnames", () => {
    const moved = withRecipeHosts(recipe({ urlPattern: "examplemovies\\.at/movie" }), [
      "examplemovies.at",
      "examplemovies.app",
    ]);
    expect(moved.match.hostnames).toEqual(["examplemovies.at", "examplemovies.app"]);
    expect(moved.match.urlPattern).toBe("/movie");
  });

  it("drops the list when given no hosts", () => {
    const freed = withRecipeHosts(recipe({ urlPattern: "examplemovies\\.at/movie" }), []);
    expect(freed.match.hostnames).toBeUndefined();
    expect(freed.match.urlPattern).toBe("/movie");
  });
});

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("a.b+c")).toBe("a\\.b\\+c");
  });
});

describe("siteLabel", () => {
  it("takes the name part and ignores www, subdomains, and the ending", () => {
    expect(siteLabel("examplewatch.to")).toBe("examplewatch");
    expect(siteLabel("www.examplewatch.pk")).toBe("examplewatch");
    expect(siteLabel("watch.examplewatch.to")).toBe("examplewatch");
  });

  it("looks past a second-level ending like co.uk", () => {
    expect(siteLabel("examplewatch.co.uk")).toBe("examplewatch");
  });

  it("is empty for a bare name", () => {
    expect(siteLabel("localhost")).toBe("");
  });
});
