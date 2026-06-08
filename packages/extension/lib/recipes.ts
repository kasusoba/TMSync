import { type LibraryLink, type Recipe, parseLibrary } from "@tmsync/shared";
// Bundled seed list — a fallback so the extension works offline / before the
// first CDN fetch. The remote list (when present) supersedes it.
import rawBundled from "../../../recipes/index.json";
import { customRecipes, remoteRecipes } from "./storage";

const bundledLibrary = parseLibrary(rawBundled);
const bundled = bundledLibrary.recipes;

/** Quick-link sites shipped in the bundled library (seeded even before a fetch). */
export const bundledLinks: LibraryLink[] = bundledLibrary.links;

/**
 * The recipes the engine should use, merged by precedence: the user's own custom
 * recipes win, then the fetched remote list, then the bundled seed. Deduped by
 * id (first wins) so a custom recipe overrides a remote/bundled one with the
 * same id, and `selectRecipe` picks the user's version when several match a URL.
 */
export async function loadRecipes(): Promise<Recipe[]> {
  const [remoteEntry, custom] = await Promise.all([
    remoteRecipes.getValue(),
    customRecipes.getValue(),
  ]);
  const seen = new Set<string>();
  const merged: Recipe[] = [];
  for (const r of [...custom, ...(remoteEntry?.recipes ?? []), ...bundled]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return merged;
}
