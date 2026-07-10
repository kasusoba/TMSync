/**
 * Human-readable, content-STABLE recipe ids (docs/IDENTITY-NAMESPACES.md).
 *
 * The old id was `custom-<host>-<Date.now()>` — unique per device, so two users
 * contributing the same site produced different ids → silent duplicate entries in
 * the shared list (worse than a conflict). A stable id derived from the host makes
 * a re-contribution an UPDATE, dedupes issue/PR titles, and lets the contribution
 * branch be keyed by content instead of issue number.
 *
 * The id is NOT a foreign key anywhere: corrections are keyed by the scraped media
 * (see trakt/util `resolutionCacheKey`), quick links carry their own ids, and no
 * store references a recipe id — so migrating ids only rewrites `customRecipes`.
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
