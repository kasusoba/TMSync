import { type LibraryLink, type Recipe, parseLibrary, recipeHosts } from "@tmsync/shared";
// Bundled seed list — a fallback so the extension works offline / before the
// first CDN fetch. The remote list (when present) supersedes it. It's one
// tracker-agnostic file: every recipe carries its own `tracker` field and the
// engine routes per-recipe, so Trakt and AniList (and future trackers) coexist
// in the same list.
import rawBundled from "../../../recipes/index.json";
import { customRecipes, remoteRecipes } from "./storage";

const bundledLibrary = parseLibrary(rawBundled);
const bundled = bundledLibrary.recipes;

/** Quick-link sites shipped in the bundled library (seeded even before a fetch). */
export const bundledLinks: LibraryLink[] = bundledLibrary.links;

/** What makes two recipes the same target: the same hosts AND the same pattern.
 * The host belongs to `hostnames` now, so the pattern alone is no longer unique
 * (every site has a `/movie` recipe). */
const targetKey = (r: Recipe) => `${recipeHosts(r).sort().join(",")}|${r.match.urlPattern}`;

/**
 * The recipes the engine should use, merged by precedence: the user's own custom
 * recipes win, then the fetched remote list, then the bundled seed. Deduped by
 * BOTH id and target (first wins), so a local recipe for a site cleanly SHADOWS
 * a library recipe covering the same URL even if their ids differ. The result is
 * one effective recipe per target, never a confusing double match.
 */
export async function loadRecipes(): Promise<Recipe[]> {
  const [remoteEntry, custom] = await Promise.all([
    remoteRecipes.getValue(),
    customRecipes.getValue(),
  ]);
  const seenIds = new Set<string>();
  const seenTargets = new Set<string>();
  const merged: Recipe[] = [];
  for (const r of [...custom, ...(remoteEntry?.recipes ?? []), ...bundled]) {
    const target = targetKey(r);
    if (seenIds.has(r.id) || seenTargets.has(target)) continue;
    seenIds.add(r.id);
    seenTargets.add(target);
    merged.push(r);
  }
  return merged;
}
