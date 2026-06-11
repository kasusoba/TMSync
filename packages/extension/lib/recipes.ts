import { type LibraryLink, type Recipe, parseLibrary } from "@tmsync/shared";
// Bundled seed lists — a fallback so the extension works offline / before the
// first CDN fetch. The remote list (when present) supersedes it. The anime list
// is kept SEPARATE from the public Trakt list (CLAUDE.md: keep recipes/anime/
// apart so the shareable Trakt list stays clean); it's merged at load by the
// engine and routed by each recipe's `tracker` field.
import rawAnime from "../../../recipes/anime/index.json";
import rawBundled from "../../../recipes/index.json";
import { customRecipes, remoteRecipes } from "./storage";

const bundledLibrary = parseLibrary(rawBundled);
const bundledAnime = parseLibrary(rawAnime);
const bundled = [...bundledLibrary.recipes, ...bundledAnime.recipes];

/** Quick-link sites shipped in the bundled library (seeded even before a fetch). */
export const bundledLinks: LibraryLink[] = bundledLibrary.links;

/**
 * The recipes the engine should use, merged by precedence: the user's own custom
 * recipes win, then the fetched remote list, then the bundled seed. Deduped by
 * BOTH id and urlPattern (first wins) — so a local recipe for a site cleanly
 * SHADOWS a library recipe covering the same URL even if their ids differ. The
 * result is one effective recipe per pattern, never a confusing double match.
 */
export async function loadRecipes(): Promise<Recipe[]> {
  const [remoteEntry, custom] = await Promise.all([
    remoteRecipes.getValue(),
    customRecipes.getValue(),
  ]);
  const seenIds = new Set<string>();
  const seenPatterns = new Set<string>();
  const merged: Recipe[] = [];
  for (const r of [...custom, ...(remoteEntry?.recipes ?? []), ...bundled]) {
    if (seenIds.has(r.id) || seenPatterns.has(r.match.urlPattern)) continue;
    seenIds.add(r.id);
    seenPatterns.add(r.match.urlPattern);
    merged.push(r);
  }
  return merged;
}
