/**
 * Human-readable, content-STABLE recipe ids (docs/RECIPES.md).
 *
 * The id is derived from the host, so two people who set up the same site get the
 * same id. A local edit of a source recipe keeps the source id, which is how the
 * fork shadows it (`mergeRecipes`).
 *
 * Corrections are keyed by the scraped media (see trakt/util `resolutionCacheKey`),
 * and quick links carry their own ids. The only store keyed by recipe id is
 * `forkBases`, which records where a fork came from.
 */

/** "www.miruro.to" → "miruro-to"; "watch.example.co.uk" → "watch-example-co-uk". */
export function slugifyHost(hostname: string): string {
  return hostname
    .replace(/^www\./i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `base`, or `base-2`, `base-3`… until it doesn't collide with `used`. */
export function uniqueRecipeId(base: string, used: ReadonlySet<string>): string {
  const root = base || "recipe";
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A stable id for a new recipe on `hostname`, unique against existing recipe ids. */
export function newRecipeId(hostname: string, existingIds: Iterable<string>): string {
  return uniqueRecipeId(slugifyHost(hostname), new Set(existingIds));
}
