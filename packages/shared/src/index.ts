export {
  Field,
  IdNamespace,
  LibraryLink,
  LinkTemplates,
  minSchemaVersion,
  Recipe,
  RecipeSchema,
  recipeTrackers,
  SCHEMA_VERSION,
  Transform,
} from "./schema";
export type { Tracker } from "./schema";
export type { EngineContext, ExtractResult, ParsedMedia } from "./types";
export { applyTransforms } from "./transforms";
export {
  collectJsonLd,
  extract,
  ID_NAMESPACE_ORDER,
  isManualRecipe,
  primaryId,
  readField,
} from "./extract";
export { matchRecipe, matchesUrl, selectRecipe } from "./match";
export {
  escapeRegex,
  hostOf,
  hostText,
  normalizeHost,
  patternPath,
  recipeHosts,
  siteLabel,
  withRecipeHosts,
} from "./hosts";
export { type RecipeLibrary, parseLibrary, parseLinks, parseRecipes } from "./recipes";
export {
  ANILIST_PLACEHOLDERS,
  buildAniListSiteLinks,
  buildSiteLinks,
  fillTemplate,
  linkHost,
  placeholderHint,
  slugify,
  TRAKT_PLACEHOLDERS,
  trackerItemUrl,
  withLinkHost,
} from "./links";
export type { AniListPageMedia, PlaceholderDoc, SiteLinks, TraktPageMedia } from "./links";
// Letterboxd CSV export lives in the extension's Trakt adapter (packages/extension/
// lib/trakt/letterboxd.ts) — it's Trakt-shaped domain logic, not part of the
// tracker-agnostic shared engine.
