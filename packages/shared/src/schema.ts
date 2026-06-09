import { z } from "zod";

/**
 * Recipe schema version understood by this build of the engine.
 * Clients ignore recipes whose `schemaVersion` is newer than this.
 *
 * v2 added manual recipes (no `extract`; the user picks the title in-page on
 * sites with no readable metadata — e.g. asbplayer/twoseven). A v1-only engine
 * skips v2 recipes rather than choking on the missing `extract`.
 */
export const SCHEMA_VERSION = 2;

export const Transform = z.enum(["trim", "lowercase", "uppercase", "toInt", "collapseSpaces"]);
export type Transform = z.infer<typeof Transform>;

/**
 * A `Field` says *where* a value is and *how to clean it* — never *how to
 * compute it* with code. The engine interprets this declaratively.
 */
export const Field = z.object({
  source: z.enum(["url", "meta", "jsonld", "dom", "title"]),
  // dom: CSS selector; meta: property/name (e.g. "og:title");
  // jsonld: dotted path (e.g. "partOfTVSeason.seasonNumber")
  selector: z.string().optional(),
  attr: z.string().optional(), // dom only: read an attribute instead of textContent
  regex: z.string().optional(), // applied to the raw string
  group: z.number().int().optional(), // capture group index (default 1)
  transforms: z.array(Transform).optional(),
});
export type Field = z.infer<typeof Field>;

/**
 * URL templates for deep-linking FROM a Trakt page OUT to a streaming site (the
 * "quick links" feature). Declarative data — placeholders are substituted, never
 * executed. Supported placeholders:
 *   {tmdb} {imdb}      — ids read from Trakt's own external links
 *   {title}            — URL-encoded title; {slug} — lowercase, hyphen-joined
 *   {season} {episode} — for `tv` (show → S1E1, season → S{n}E1, episode → S{n}E{m})
 * A `tv`/`movie` template that references an id we don't have falls back to
 * `search`. Quick links are managed per-SITE, independent of recipes (which are
 * scraping config) — see the extension's quickLinks store.
 */
export const LinkTemplates = z.object({
  movie: z.string().optional(),
  tv: z.string().optional(),
  search: z.string().optional(),
});
export type LinkTemplates = z.infer<typeof LinkTemplates>;

/**
 * A quick-link site shared through the recipe library (the `links` section of
 * index.json). Per-site, separate from recipes (scraping config) but contributed
 * in the same file. The client adds these to the user's quick-links disabled by
 * default — the user enables their favourites.
 */
export const LibraryLink = LinkTemplates.extend({
  id: z.string(),
  name: z.string(),
});
export type LibraryLink = z.infer<typeof LibraryLink>;

export const Recipe = z.object({
  id: z.string(),
  schemaVersion: z.number().int(), // client ignores recipes with a newer schemaVersion than it supports
  name: z.string(), // human-readable site name
  match: z.object({
    urlPattern: z.string(), // regex tested against location.href
    domFingerprint: z.string().optional(), // a selector that must exist; primary clone-resilient key
    hostnames: z.array(z.string()).optional(), // hints only, not the primary match
  }),
  mediaType: z.enum(["auto", "movie", "show"]).default("auto"),
  video: z
    .object({
      selector: z.string().default("video"),
      frame: z.enum(["auto", "top", "iframe"]).default("auto"),
      // per-site "treat as finished here" point for firing stop on sites with long
      // credits; NOT the watched decision (Trakt applies its own 80% on /scrobble/stop)
      watchedThreshold: z.number().min(0).max(1).default(0.8),
    })
    .default({}),
  // Omitted on MANUAL recipes: sites with no readable title (local-file players,
  // watch-party rooms) where one URL serves everything. The user picks the title
  // in-page instead; see `manualKey`. A recipe with no `extract` is manual.
  extract: z
    .object({
      title: Field,
      year: Field.optional(), // helps movie disambiguation
      season: Field.optional(), // shows
      episode: Field.optional(), // shows
    })
    .optional(),
  // MANUAL recipes only: a field whose VALUE distinguishes the current content
  // (a filename, a room/media title) so a manual pick can be remembered and
  // re-applied when the same thing plays again. NOT resolved against Trakt — it
  // is purely a cache key. Absent ⇒ the engine falls back to document.title.
  manualKey: Field.optional(),
});

export type Recipe = z.infer<typeof Recipe>;
export const RecipeSchema = Recipe;
