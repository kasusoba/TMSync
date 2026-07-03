import { z } from "zod";

/**
 * Recipe schema version understood by this build of the engine.
 * Clients ignore recipes whose `schemaVersion` is newer than this.
 *
 * v2 added two things:
 *   - manual recipes (no `extract`; the user picks the title in-page on sites
 *     with no readable metadata — e.g. asbplayer/twoseven). A v1-only engine
 *     skips v2 recipes rather than choking on the missing `extract`.
 *   - the `tracker` field, routing a site to Trakt or AniList. It is optional
 *     with a `"trakt"` default, so it is purely additive — v1 recipes (and v2
 *     recipes that omit it) still parse and default to Trakt, the original
 *     behaviour. `tracker: "anilist"` recipes carry `schemaVersion: 2`.
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
 * URL templates for deep-linking FROM a tracker page OUT to a streaming site (the
 * "quick links" feature). Declarative data — placeholders are substituted, never
 * executed. Supported placeholders:
 *   Trakt page (movie/tv): {tmdb} {imdb} (ids from Trakt's external links),
 *     {title} (URL-encoded), {slug} (lowercase, hyphen-joined), {slugyear},
 *     {season} {episode} (tv: show → S1E1, season → S{n}E1, episode → S{n}E{m}).
 *   AniList page (`anime`): {anilistId}, {title} (English/romaji, URL-encoded),
 *     {romaji} (URL-encoded), {slug}.
 * A direct template that references an id we don't have falls back to `search`.
 * Which tracker's pages a link shows on is decided by `tracker` (below); the
 * `anime` template is the AniList analogue of `movie`/`tv`. Quick links are
 * managed per-SITE, independent of recipes — see the extension's quickLinks store.
 */
export const LinkTemplates = z.object({
  movie: z.string().optional(),
  tv: z.string().optional(),
  anime: z.string().optional(),
  search: z.string().optional(),
});
export type LinkTemplates = z.infer<typeof LinkTemplates>;

/**
 * A quick-link site shared through the recipe library (the `links` section of
 * index.json). Per-site, separate from recipes (scraping config) but contributed
 * in the same file. The client adds these to the user's quick-links disabled by
 * default — the user enables their favourites. `tracker` decides which tracker's
 * pages it injects on (trakt.tv vs anilist.co); v1 links default to `trakt`.
 */
export const LibraryLink = LinkTemplates.extend({
  id: z.string(),
  name: z.string(),
  tracker: z.enum(["trakt", "anilist"]).default("trakt"),
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
  // Which tracker adapter records this site. Routed, never synced (one item →
  // one tracker). `"anilist"` ⇒ anime *series* only, on dedicated anime sites;
  // everything else (movies — anime or not — and non-anime TV) is `"trakt"`.
  // Optional + default `"trakt"` keeps v1/older-v2 recipes back-compatible. The
  // engine selects the adapter by this field; `extract()` stays tracker-agnostic.
  // Legacy single-tracker field (v1/older-v2 recipes). New recipes use `trackers`
  // below; `tracker` is kept for back-compat + as a default. Its "trakt" default is
  // why `recipeTrackers()` treats `trackers` as authoritative, not a union.
  tracker: z.enum(["trakt", "anilist"]).default("trakt"),
  // MULTI-TRACK (docs/MULTI-TRACK.md): the set of trackers this recipe records to —
  // the user's toggled set (a pluggable list; more trackers may be added later).
  // AUTHORITATIVE when present. Which one is "native" (its numbering matches the
  // page → written directly) vs "derived" (mapped via the anime-map crosswalk,
  // best-effort, refuse-on-ambiguous, skip-on-miss) is inferred at scrobble time
  // from the scraped media — not chosen here. Additive: omitted ⇒ `[tracker]`, so
  // older recipes/engines degrade to single-tracker (no schemaVersion bump). Read
  // via `recipeTrackers()`, never `recipe.trackers` directly.
  trackers: z.array(z.enum(["trakt", "anilist"])).optional(),
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
      // Optional because a TMDB id can stand in as the identity (below). A recipe
      // still needs ONE of title/tmdbId — enforced by the refine.
      title: Field.optional(),
      year: Field.optional(), // helps movie disambiguation
      season: Field.optional(), // shows
      episode: Field.optional(), // shows
      // The TMDB id (usually from the URL, e.g. /movie/693134 or ?id=276161).
      // When present the Trakt adapter resolves by id — exact, no remake/same-
      // title ambiguity — so the title is optional (and a mere display fallback).
      tmdbId: Field.optional(),
    })
    .refine((e) => e.title !== undefined || e.tmdbId !== undefined, {
      message: "a recipe needs a title or a TMDB id to resolve",
    })
    .optional(),
  // MANUAL recipes only: a field whose VALUE distinguishes the current content
  // (a filename, a room/media title) so a manual pick can be remembered and
  // re-applied when the same thing plays again. NOT resolved against Trakt — it
  // is purely a cache key. Absent ⇒ the engine falls back to document.title.
  manualKey: Field.optional(),
  // ANIME quick-links only: how to read this site's STABLE series slug/identifier
  // from the page (MALSync's getIdentifier idea, kept declarative). When present,
  // TMSync captures `(host, AniList id) → this value` on each watch (the local
  // "crosswalk") and reuses it to fill the `{slug}`/`{canonical}` placeholder in
  // the site's anime quick link — so the link hits the EXACT page instead of a
  // guessed title-slug. Anime sites often append unguessable junk to URLs; this
  // is how we route around that without a backend. Absent ⇒ fall back to search.
  canonical: Field.optional(),
});

export type Recipe = z.infer<typeof Recipe>;
export const RecipeSchema = Recipe;

/** A tracker this build knows about. */
export type Tracker = Recipe["tracker"];

/**
 * The set of trackers a recipe writes to (multi-track — docs/MULTI-TRACK.md).
 * `trackers` is AUTHORITATIVE when present (the user's toggled set), deduped; only
 * a legacy recipe with no `trackers` falls back to the single `tracker`. It is NOT
 * unioned with `tracker` — the `tracker` field defaults to "trakt", so unioning
 * would force Trakt into an AniList-only recipe. Which one is "native" (written
 * directly) vs "derived" (via the crosswalk) is inferred at scrobble time from the
 * scraped media, not from this list. Call sites read THIS, never `recipe.trackers`.
 */
export function recipeTrackers(recipe: Pick<Recipe, "tracker" | "trackers">): Tracker[] {
  return recipe.trackers?.length ? [...new Set(recipe.trackers)] : [recipe.tracker];
}
