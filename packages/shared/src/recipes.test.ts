import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLibrary, parseRecipes } from "./recipes";

const good = {
  id: "ok",
  schemaVersion: 1,
  name: "OK",
  match: { urlPattern: ".*" },
  extract: { title: { source: "title" } },
};

describe("parseRecipes", () => {
  it("returns [] for non-array input", () => {
    expect(parseRecipes(null)).toEqual([]);
    expect(parseRecipes({})).toEqual([]);
  });

  it("keeps valid recipes and discards invalid ones individually", () => {
    const bad = { id: "bad", schemaVersion: 1, name: "Bad", match: {}, extract: {} };
    const result = parseRecipes([good, bad]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("ok");
  });
});

describe("parseLibrary", () => {
  it("reads a bare recipe array", () => {
    const lib = parseLibrary([good]);
    expect(lib.recipes.map((r) => r.id)).toEqual(["ok"]);
    expect(lib.links).toEqual([]);
    expect(lib.name).toBeUndefined();
  });

  it("keeps the source name and homepage", () => {
    const lib = parseLibrary({
      name: "  My   sites ",
      homepage: "https://example.org/",
      recipes: [good],
    });
    expect(lib.name).toBe("My sites");
    expect(lib.homepage).toBe("https://example.org/");
  });

  it("drops a blank name, a long name's tail, and a non-http homepage", () => {
    expect(parseLibrary({ name: " ", recipes: [] }).name).toBeUndefined();
    expect(parseLibrary({ name: "x".repeat(100), recipes: [] }).name).toHaveLength(60);
    expect(parseLibrary({ homepage: "javascript:alert(1)", recipes: [] }).homepage).toBeUndefined();
    expect(parseLibrary({ homepage: "not a url", recipes: [] }).homepage).toBeUndefined();
  });
});

describe("live recipes/index.json", () => {
  // vitest runs with cwd = packages/shared; the recipe library lives at repo root.
  // ONE tracker-agnostic file — Trakt and AniList recipes coexist, routed by each
  // recipe's own `tracker` field. The central list is rebuilt from scratch (may be
  // empty); validate whatever is shipped rather than requiring content.
  const indexPath = resolve(process.cwd(), "../../recipes/index.json");
  const raw = JSON.parse(readFileSync(indexPath, "utf8"));

  it("every shipped recipe still parses", () => {
    const lib = parseLibrary(raw);
    expect(lib.recipes).toHaveLength(raw.recipes.length);
  });

  it("every shipped recipe routes to a known tracker", () => {
    const lib = parseLibrary(raw);
    expect(lib.recipes.every((r) => r.tracker === "trakt" || r.tracker === "anilist")).toBe(true);
  });
});
