import type { Recipe } from "@tmsync/shared";
import {
  type ForkBase,
  type RecipeSource,
  type SourceCache,
  customRecipes,
  forkBases,
  recipeSources,
  siteSourcePins,
  sourceCaches,
} from "../storage";
import {
  type SourceChoice,
  type SourcedRecipe,
  mergeRecipes,
  resolveSources,
  staleForks,
} from "./sources";

export { recipeTarget } from "./sources";

/** Everything the recipe list is built from, read in one go. */
export interface RecipeState {
  custom: Recipe[];
  sources: RecipeSource[];
  caches: Record<string, SourceCache>;
  pins: Record<string, string>;
  bases: Record<string, ForkBase>;
  /** The sourced recipes after the one-source-per-site rule. */
  sourced: SourcedRecipe[];
  /** Sites that several sources cover, and which one each uses. */
  choices: SourceChoice[];
  /** Ids of forks whose source version changed since the fork. */
  stale: string[];
}

export async function loadRecipeState(): Promise<RecipeState> {
  const [custom, sources, caches, pins, bases] = await Promise.all([
    customRecipes.getValue(),
    recipeSources.getValue(),
    sourceCaches.getValue(),
    siteSourcePins.getValue(),
    forkBases.getValue(),
  ]);
  const { recipes: sourced, choices } = resolveSources(sources, caches, pins);
  const stale = staleForks(custom, sourced, bases);
  return { custom, sources, caches, pins, bases, sourced, choices, stale };
}

/** The effective recipes with the source each came from (unset on the user's own). */
export function effectiveRecipes(s: RecipeState): { recipe: Recipe; sourceId?: string }[] {
  return mergeRecipes(s.custom, s.sourced, s.bases);
}

/**
 * The recipes the engine should use: the user's own first, then the sources in
 * priority order with one source per site (lib/recipes/sources.ts). One recipe
 * per target, so a local recipe for a site cleanly SHADOWS a source recipe that
 * covers the same URL even if their ids differ.
 */
export async function loadRecipes(): Promise<Recipe[]> {
  return effectiveRecipes(await loadRecipeState()).map((e) => e.recipe);
}

/** Every storage item `loadRecipes` reads, for a caller that reloads on change. */
export function watchRecipes(cb: () => void): () => void {
  const off = [
    customRecipes.watch(cb),
    recipeSources.watch(cb),
    sourceCaches.watch(cb),
    siteSourcePins.watch(cb),
    forkBases.watch(cb),
  ];
  return () => {
    for (const f of off) f();
  };
}
