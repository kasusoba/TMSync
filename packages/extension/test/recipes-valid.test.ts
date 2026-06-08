import { parseLibrary } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import rawLibrary from "../../../recipes/index.json";

/**
 * The shipped library file must fully validate against the schema. If a PR adds
 * a malformed recipe/link, parseLibrary silently drops it — so we assert that
 * every raw entry survives validation (count in === count out) and ids are unique.
 */
describe("recipes/index.json", () => {
  const raw = rawLibrary as { recipes?: unknown[]; links?: unknown[] };
  const parsed = parseLibrary(rawLibrary);

  it("has recipes and links arrays", () => {
    expect(Array.isArray(raw.recipes)).toBe(true);
    expect(Array.isArray(raw.links)).toBe(true);
  });

  it("every recipe passes the Zod schema", () => {
    expect(parsed.recipes).toHaveLength(raw.recipes?.length ?? 0);
  });

  it("every link passes the Zod schema", () => {
    expect(parsed.links).toHaveLength(raw.links?.length ?? 0);
  });

  it("has unique recipe ids and unique link ids", () => {
    const recipeIds = parsed.recipes.map((r) => r.id);
    const linkIds = parsed.links.map((l) => l.id);
    expect(new Set(recipeIds).size).toBe(recipeIds.length);
    expect(new Set(linkIds).size).toBe(linkIds.length);
  });
});
