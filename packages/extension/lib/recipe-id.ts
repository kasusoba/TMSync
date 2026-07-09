import { type Recipe, RecipeSchema } from "@tmsync/shared";

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

const LEGACY_ID = /^custom-(.+)-\d{10,}$/; // custom-<host>-<Date.now()>

/**
 * Migrate stored custom recipes to stable ids (immediate migration). Re-parses each
 * through {@link RecipeSchema} — which also folds a legacy `extract.tmdbId` into
 * `extract.ids.tmdb` (schema v3) — drops anything that no longer validates, rewrites
 * timestamped ids to host slugs, and de-dupes. Non-legacy ids are kept as-is.
 */
export function migrateCustomRecipeIds(list: unknown): Recipe[] {
  const raw = Array.isArray(list) ? list : [];
  const out: Recipe[] = [];
  const used = new Set<string>();
  for (const entry of raw) {
    const parsed = RecipeSchema.safeParse(entry);
    if (!parsed.success) continue;
    const recipe = parsed.data;
    const legacy = LEGACY_ID.exec(recipe.id);
    const base = legacy?.[1] ? slugifyHost(legacy[1]) : recipe.id;
    const id = uniqueRecipeId(base, used);
    used.add(id);
    out.push(id === recipe.id ? recipe : { ...recipe, id });
  }
  return out;
}
