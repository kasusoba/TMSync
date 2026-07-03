import { RecipeSchema, recipeTrackers } from "@tmsync/shared";
import { describe, expect, it } from "vitest";

/** Minimal valid recipe; override fields per case. */
function recipe(over: Record<string, unknown> = {}) {
  return RecipeSchema.parse({
    id: "site",
    schemaVersion: 2,
    name: "Site",
    match: { urlPattern: ".*" },
    extract: { title: { source: "title" } },
    ...over,
  });
}

describe("multi-track: recipe.trackers (additive) + recipeTrackers()", () => {
  it("omitted trackers ⇒ single-tracker set from the default primary (trakt)", () => {
    const r = recipe();
    expect(r.tracker).toBe("trakt");
    expect(r.trackers).toBeUndefined(); // truly additive — not materialized on parse
    expect(recipeTrackers(r)).toEqual(["trakt"]);
  });

  it("anilist primary, no trackers ⇒ [anilist]", () => {
    expect(recipeTrackers(recipe({ tracker: "anilist" }))).toEqual(["anilist"]);
  });

  it("explicit set is returned as-is", () => {
    const r = recipe({ tracker: "trakt", trackers: ["trakt", "anilist"] });
    expect(recipeTrackers(r)).toEqual(["trakt", "anilist"]);
  });

  it("trackers is AUTHORITATIVE — the legacy tracker default is not unioned in", () => {
    // AniList-only recipe: the "trakt" default of `tracker` must NOT sneak in.
    const r = recipe({ tracker: "trakt", trackers: ["anilist"] });
    expect(recipeTrackers(r)).toEqual(["anilist"]);
  });

  it("dedupes", () => {
    const r = recipe({ tracker: "anilist", trackers: ["anilist", "anilist", "trakt"] });
    expect(recipeTrackers(r)).toEqual(["anilist", "trakt"]);
  });

  it("back-compat: a v1/v2 recipe with no tracker fields still parses and defaults to trakt", () => {
    const r = RecipeSchema.parse({
      id: "legacy",
      schemaVersion: 1,
      name: "Legacy",
      match: { urlPattern: ".*" },
      extract: { title: { source: "title" } },
    });
    expect(recipeTrackers(r)).toEqual(["trakt"]);
  });

  it("rejects an unknown tracker in the set", () => {
    expect(
      RecipeSchema.safeParse({
        id: "bad",
        schemaVersion: 2,
        name: "Bad",
        match: { urlPattern: ".*" },
        extract: { title: { source: "title" } },
        trackers: ["trakt", "simkl"],
      }).success,
    ).toBe(false);
  });
});
