import { describe, expect, it } from "vitest";
import { migrateCustomRecipeIds, newRecipeId, slugifyHost, uniqueRecipeId } from "./recipe-id";

describe("slugifyHost", () => {
  it("strips www., lowercases, and hyphenates dots", () => {
    expect(slugifyHost("www.miruro.to")).toBe("miruro-to");
    expect(slugifyHost("Cineby.at")).toBe("cineby-at");
    expect(slugifyHost("watch.example.co.uk")).toBe("watch-example-co-uk");
  });
});

describe("uniqueRecipeId", () => {
  it("returns the base when free, else appends -2, -3…", () => {
    expect(uniqueRecipeId("miruro-to", new Set())).toBe("miruro-to");
    expect(uniqueRecipeId("miruro-to", new Set(["miruro-to"]))).toBe("miruro-to-2");
    expect(uniqueRecipeId("miruro-to", new Set(["miruro-to", "miruro-to-2"]))).toBe("miruro-to-3");
  });
});

describe("newRecipeId", () => {
  it("derives a stable slug, disambiguating same-host recipes", () => {
    expect(newRecipeId("www.miruro.to", [])).toBe("miruro-to");
    expect(newRecipeId("www.miruro.to", ["miruro-to"])).toBe("miruro-to-2");
  });
});

const baseRecipe = {
  schemaVersion: 3,
  name: "Miruro",
  match: { urlPattern: "www\\.miruro\\.to/watch", hostnames: ["www.miruro.to"] },
  extract: { title: { source: "dom", selector: "h1" } },
};

describe("migrateCustomRecipeIds", () => {
  it("rewrites a timestamped id to a host slug", () => {
    const out = migrateCustomRecipeIds([
      { ...baseRecipe, id: "custom-www.miruro.to-1782750678443" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("miruro-to");
  });

  it("keeps an already-stable id untouched", () => {
    const out = migrateCustomRecipeIds([{ ...baseRecipe, id: "miruro-to" }]);
    expect(out[0]?.id).toBe("miruro-to");
  });

  it("de-dupes two timestamped ids on the same host", () => {
    const out = migrateCustomRecipeIds([
      { ...baseRecipe, id: "custom-www.miruro.to-1782750678111", match: { urlPattern: "a" } },
      { ...baseRecipe, id: "custom-www.miruro.to-1782750678222", match: { urlPattern: "b" } },
    ]);
    expect(out.map((r) => r.id)).toEqual(["miruro-to", "miruro-to-2"]);
  });

  it("folds a legacy extract.tmdbId into ids.tmdb during migration", () => {
    const out = migrateCustomRecipeIds([
      {
        ...baseRecipe,
        id: "custom-www.miruro.to-1782750678333",
        extract: { tmdbId: { source: "url", regex: "/tv/(\\d+)", transforms: ["toInt"] } },
      },
    ]);
    expect(out[0]?.extract?.ids?.tmdb?.regex).toBe("/tv/(\\d+)");
  });

  it("drops entries that no longer validate", () => {
    const out = migrateCustomRecipeIds([
      { id: "broken", schemaVersion: 3 },
      { ...baseRecipe, id: "x" },
    ]);
    expect(out.map((r) => r.id)).toEqual(["x"]);
  });

  it("tolerates a non-array value", () => {
    expect(migrateCustomRecipeIds(null)).toEqual([]);
  });
});
