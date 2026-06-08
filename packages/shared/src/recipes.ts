import {
  type LibraryLink,
  LibraryLink as LibraryLinkSchema,
  type Recipe,
  RecipeSchema,
} from "./schema";

/** The recipe library file: a `recipes` list plus an optional `links` list. */
export interface RecipeLibrary {
  recipes: Recipe[];
  links: LibraryLink[];
}

/**
 * Validate an untrusted recipe list (e.g. fetched JSON) against the schema.
 * Each entry is validated independently and a failing recipe is **discarded**,
 * never partially applied — so one malformed entry can't poison the whole list.
 */
export function parseRecipes(input: unknown): Recipe[] {
  if (!Array.isArray(input)) return [];
  const out: Recipe[] = [];
  for (const entry of input) {
    const result = RecipeSchema.safeParse(entry);
    if (result.success) out.push(result.data);
  }
  return out;
}

/** Validate a library link list, discarding malformed entries (like parseRecipes). */
export function parseLinks(input: unknown): LibraryLink[] {
  if (!Array.isArray(input)) return [];
  const out: LibraryLink[] = [];
  for (const entry of input) {
    const result = LibraryLinkSchema.safeParse(entry);
    if (result.success) out.push(result.data);
  }
  return out;
}

/**
 * Parse the library file in either shape: the current object form
 * `{ recipes, links }`, or a bare `Recipe[]` (back-compat). Both validated.
 */
export function parseLibrary(input: unknown): RecipeLibrary {
  if (Array.isArray(input)) return { recipes: parseRecipes(input), links: [] };
  const obj = (input ?? {}) as { recipes?: unknown; links?: unknown };
  return { recipes: parseRecipes(obj.recipes), links: parseLinks(obj.links) };
}
