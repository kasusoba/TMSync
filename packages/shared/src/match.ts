import { hostOf, normalizeHost } from "./hosts";
import { type Recipe, SCHEMA_VERSION } from "./schema";
import type { EngineContext } from "./types";

/** The recipe's explicit host scope, normalized. Empty ⇒ the recipe is host-free. */
function hostScope(recipe: Recipe): string[] {
  return recipe.match.hostnames?.map(normalizeHost).filter(Boolean) ?? [];
}

/** Whether the URL is inside the recipe's host scope (a host-free recipe covers all). */
function inHostScope(recipe: Recipe, url: string): boolean {
  const scope = hostScope(recipe);
  return scope.length === 0 || scope.includes(hostOf(url));
}

/**
 * Match a recipe against the current page by host scope + URL pattern + DOM
 * fingerprint.
 *
 * `match.hostnames` is the host scope: a site that moves domain keeps its recipe
 * and gains a hostname (see lib/hosts.ts). It is also what the background asks
 * host permission for, so it is maintained either way. A recipe with no hostnames
 * is host-free and rests on its pattern + fingerprint alone.
 *
 * The fingerprint is the clone-resilient key: one recipe covers a site's mirror
 * domains as long as the marker selector is there.
 */
export function matchRecipe(recipe: Recipe, ctx: EngineContext): boolean {
  if (!matchesUrl(recipe, ctx.url)) return false;
  return matchesFingerprint(recipe, ctx.document);
}

/** Host scope + URL pattern, with no DOM. For callers that have a URL only (the popup). */
export function matchesUrl(recipe: Recipe, url: string): boolean {
  if (!inHostScope(recipe, url)) return false;
  try {
    return new RegExp(recipe.match.urlPattern).test(url);
  } catch {
    return false; // malformed pattern — never matches
  }
}

function matchesFingerprint(recipe: Recipe, document: Document): boolean {
  const fingerprint = recipe.match.domFingerprint;
  if (!fingerprint) return true;
  try {
    return document.querySelector(fingerprint) !== null;
  } catch {
    return false; // invalid selector — never matches
  }
}

/**
 * Why a page does or does not match: for each recipe whose host scope covers the
 * URL (a host-free recipe counts only when its URL pattern fits), whether its URL
 * pattern and its page marker pass. `marker` is null when the recipe has none. For
 * the popup's "Why no badge?" check, not for matching.
 */
export function explainMatch(
  recipes: Recipe[],
  ctx: EngineContext,
): { recipe: Recipe; url: boolean; marker: boolean | null }[] {
  return recipes
    .filter((r) => r.schemaVersion <= SCHEMA_VERSION && inHostScope(r, ctx.url))
    .map((recipe) => ({
      recipe,
      url: matchesUrl(recipe, ctx.url),
      marker: recipe.match.domFingerprint ? matchesFingerprint(recipe, ctx.document) : null,
    }))
    .filter((c) => hostScope(c.recipe).length > 0 || c.url);
}

/**
 * Pick the first recipe that both (a) targets a schema version this engine
 * understands and (b) matches the page. Returns `null` when nothing matches.
 */
export function selectRecipe(recipes: Recipe[], ctx: EngineContext): Recipe | null {
  for (const recipe of recipes) {
    if (recipe.schemaVersion > SCHEMA_VERSION) continue;
    if (matchRecipe(recipe, ctx)) return recipe;
  }
  return null;
}
