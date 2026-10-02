import {
  type LibraryLink,
  LibraryLink as LibraryLinkSchema,
  type Recipe,
  RecipeSchema,
} from "./schema";

/** A recipe source file: a `recipes` list, an optional `links` list, and an
 * optional `name` and `homepage` that the options page shows for the source. */
export interface RecipeLibrary {
  recipes: Recipe[];
  links: LibraryLink[];
  name?: string;
  homepage?: string;
}

/** Longest source name kept. A longer one is cut, so a file cannot flood the UI. */
const MAX_NAME = 60;

/** The source's display name, or undefined when it is missing or blank. */
function parseName(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const name = input.trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
  return name || undefined;
}

/** The source's homepage, kept only when it is an http(s) URL. */
function parseHomepage(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
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
 * Parse a recipe source file in either shape: the object form
 * `{ name?, homepage?, recipes, links? }`, or a bare `Recipe[]`. All validated.
 */
export function parseLibrary(input: unknown): RecipeLibrary {
  if (Array.isArray(input)) return { recipes: parseRecipes(input), links: [] };
  const obj = (input ?? {}) as {
    recipes?: unknown;
    links?: unknown;
    name?: unknown;
    homepage?: unknown;
  };
  const lib: RecipeLibrary = { recipes: parseRecipes(obj.recipes), links: parseLinks(obj.links) };
  const name = parseName(obj.name);
  const homepage = parseHomepage(obj.homepage);
  if (name) lib.name = name;
  if (homepage) lib.homepage = homepage;
  return lib;
}
