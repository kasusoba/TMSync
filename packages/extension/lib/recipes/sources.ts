import {
  type LibraryLink,
  type Recipe,
  hostOf,
  linkHost,
  normalizeHost,
  recipeHosts,
} from "@tmsync/shared";
import type { ForkBase, RecipeSource, SourceCache } from "../storage";

/**
 * Recipe sources: how several user-added recipe files combine into one list.
 * Pure, so every rule here has a unit test. The rules (docs/RECIPES.md):
 *
 *  1. The user's own recipes win over every source (applied in `mergeRecipes`).
 *  2. A site comes from ONE source, whole. Two sources never mix recipes on one
 *     site, because the mix is a set that neither author tested.
 *  3. That source is the one the user pinned for the site, else the highest
 *     enabled source in the list.
 *  4. A host-free recipe matches any host, so it is not part of a site. It joins
 *     the list in its source's priority order, and the first match wins.
 */

/** A recipe and the source it came from. */
export interface SourcedRecipe {
  recipe: Recipe;
  sourceId: string;
}

/** One site that two or more sources cover, and which one won. */
export interface SourceChoice {
  /** Comparison-form hosts of the site, across every source that covers it. */
  hosts: string[];
  sourceId: string;
  /** The other sources that cover it, in priority order. */
  others: string[];
  /** True when the user picked `sourceId` (a pin), not the list order. */
  pinned: boolean;
}

/** One source's recipes for one site: the recipes that share a host. */
interface Unit {
  layer: number;
  sourceId: string;
  hosts: Set<string>;
  /** Each recipe with its position in the source file. */
  recipes: { recipe: Recipe; at: number }[];
}

/** Group one source's recipes into sites by shared host. Host-free recipes are
 *  returned apart. */
function unitsOf(
  layer: number,
  sourceId: string,
  recipes: Recipe[],
): { units: Unit[]; free: { recipe: Recipe; at: number }[] } {
  let units: Unit[] = [];
  const free: { recipe: Recipe; at: number }[] = [];
  for (const [at, recipe] of recipes.entries()) {
    const hosts = recipeHosts(recipe).map(normalizeHost).filter(Boolean);
    if (hosts.length === 0) {
      free.push({ recipe, at });
      continue;
    }
    const joined = units.filter((u) => hosts.some((h) => u.hosts.has(h)));
    const merged: Unit = {
      layer,
      sourceId,
      hosts: new Set([...joined.flatMap((u) => [...u.hosts]), ...hosts]),
      recipes: [...joined.flatMap((u) => u.recipes), { recipe, at }],
    };
    units = [...units.filter((u) => !joined.includes(u)), merged];
  }
  return { units, free };
}

/** The enabled sources that have a cached copy, in priority order. */
function layers(sources: RecipeSource[], caches: Record<string, SourceCache>) {
  return sources
    .filter((s) => s.enabled && caches[s.id])
    .map((s) => ({ id: s.id, cache: caches[s.id] as SourceCache }));
}

/**
 * Combine the sources into one recipe list in priority order, with one source
 * per site (rules 2 to 4). `pins` maps a comparison-form host to a source id.
 */
export function resolveSources(
  sources: RecipeSource[],
  caches: Record<string, SourceCache>,
  pins: Record<string, string>,
): { recipes: SourcedRecipe[]; choices: SourceChoice[] } {
  type Placed = SourcedRecipe & { layer: number; at: number };
  const all: Unit[] = [];
  const free: Placed[] = [];
  layers(sources, caches).forEach(({ id, cache }, layer) => {
    const split = unitsOf(layer, id, cache.recipes);
    all.push(...split.units);
    free.push(...split.free.map((r) => ({ ...r, sourceId: id, layer })));
  });

  // Cluster units across sources: two units that share a host are one site.
  let clusters: Unit[][] = [];
  for (const unit of all) {
    const joined = clusters.filter((c) =>
      c.some((u) => [...u.hosts].some((h) => unit.hosts.has(h))),
    );
    clusters = [...clusters.filter((c) => !joined.includes(c)), [...joined.flat(), unit]];
  }

  const picked: Placed[] = [];
  const choices: SourceChoice[] = [];
  for (const cluster of clusters) {
    const candidates = [...new Set(cluster.map((u) => u.layer))].sort((a, b) => a - b);
    const hosts = [...new Set(cluster.flatMap((u) => [...u.hosts]))];
    const idAt = (layer: number) => cluster.find((u) => u.layer === layer)?.sourceId ?? "";
    const pinnedLayer = hosts
      .map((h) => pins[h])
      .map((id) => candidates.find((l) => idAt(l) === id))
      .find((l) => l !== undefined);
    const winner = pinnedLayer ?? (candidates[0] as number);
    for (const unit of cluster.filter((u) => u.layer === winner)) {
      for (const r of unit.recipes) picked.push({ ...r, sourceId: unit.sourceId, layer: winner });
    }
    if (candidates.length > 1) {
      choices.push({
        hosts,
        sourceId: idAt(winner),
        others: candidates.filter((l) => l !== winner).map(idAt),
        pinned: pinnedLayer !== undefined,
      });
    }
  }

  // Source priority first, then each source's own order: a source author may put
  // a host-free recipe first on purpose, and the first match wins.
  const recipes = [...picked, ...free]
    .sort((a, b) => a.layer - b.layer || a.at - b.at)
    .map(({ recipe, sourceId }) => ({ recipe, sourceId }));
  return { recipes, choices };
}

/** What makes two recipes the same target: the same hosts AND the same pattern. */
export const recipeTarget = (r: Recipe) =>
  `${recipeHosts(r).sort().join(",")}|${r.match.urlPattern}`;

/**
 * The user's recipes over the sourced ones (rule 1), one recipe per target. A
 * custom recipe shadows a source recipe by id only when its fork base names that
 * source: ids are only unique inside one source, so a recipe the user made that
 * happens to share an id with some source recipe must not hide it.
 */
export function mergeRecipes(
  custom: Recipe[],
  sourced: SourcedRecipe[],
  bases: Record<string, ForkBase>,
): { recipe: Recipe; sourceId?: string }[] {
  const seenTargets = new Set<string>();
  const out: { recipe: Recipe; sourceId?: string }[] = [];
  const add = (recipe: Recipe, sourceId?: string) => {
    const target = recipeTarget(recipe);
    if (seenTargets.has(target)) return;
    seenTargets.add(target);
    out.push(sourceId ? { recipe, sourceId } : { recipe });
  };
  for (const r of custom) add(r);
  for (const { recipe, sourceId } of sourced) {
    const forked = bases[recipe.id]?.sourceId === sourceId;
    if (forked && custom.some((c) => c.id === recipe.id)) continue;
    add(recipe, sourceId);
  }
  return out;
}

/** A short, stable hash of a recipe, to tell when a source changed it. FNV-1a. */
export function recipeHash(recipe: Recipe): string {
  const text = JSON.stringify(recipe);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Ids of custom recipes whose source changed the recipe since the fork. */
export function staleForks(
  custom: Recipe[],
  sourced: SourcedRecipe[],
  bases: Record<string, ForkBase>,
): string[] {
  return custom
    .filter((r) => {
      const base = bases[r.id];
      if (!base) return false;
      const current = sourced.find((s) => s.sourceId === base.sourceId && s.recipe.id === r.id);
      return !!current && recipeHash(current.recipe) !== base.hash;
    })
    .map((r) => r.id);
}

/**
 * The quick links the sources offer, one per id and one per host. The same rule
 * as recipes: the pinned source for that host, else the highest source.
 */
export function resolveSourceLinks(
  sources: RecipeSource[],
  caches: Record<string, SourceCache>,
  pins: Record<string, string>,
): (LibraryLink & { sourceId: string })[] {
  const byKey = new Map<string, LibraryLink & { sourceId: string }>();
  const order = layers(sources, caches);
  for (const { id, cache } of order) {
    for (const link of cache.links) {
      const host = normalizeHost(linkHost(link));
      const key = host || `id:${link.id}`;
      const cur = byKey.get(key);
      const pinned = host ? pins[host] : undefined;
      // Sources come in priority order, so the first one keeps the host unless
      // the user pinned a later one.
      const better = !cur || (pinned === id && cur.sourceId !== id);
      if (better) byKey.set(key, { ...link, sourceId: id });
    }
  }
  const seenIds = new Set<string>();
  return [...byKey.values()].filter((l) => {
    if (seenIds.has(l.id)) return false;
    seenIds.add(l.id);
    return true;
  });
}

/** The name a source shows: its file's `name`, else the host of its URL. */
export function sourceLabel(source: RecipeSource, cache?: SourceCache): string {
  return cache?.name ?? (hostOf(source.url) || source.url);
}
