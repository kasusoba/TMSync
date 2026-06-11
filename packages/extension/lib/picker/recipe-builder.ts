import type { Tracker } from "@/lib/tracker/types";
import {
  type EngineContext,
  type ExtractResult,
  type Field,
  type LinkTemplates,
  type Recipe,
  RecipeSchema,
  SCHEMA_VERSION,
  extract,
  readField,
} from "@tmsync/shared";

/**
 * An in-progress recipe being assembled by the element picker. Mirrors the
 * recipe shape but with every extracted field optional while the user builds it.
 */
export interface RecipeDraft {
  match: { urlPattern: string; domFingerprint?: string; hostnames?: string[] };
  mediaType: "auto" | "movie" | "show";
  /** Which tracker this recipe routes to. "anilist" ⇒ a dedicated anime *series*
   * site whose episode numbering matches the AniList entry (constraint #2). */
  tracker: Tracker;
  video: { selector: string; frame: "auto" | "top" | "iframe" };
  /** Manual recipe: no scraping — the user picks each title from the badge. */
  manual: boolean;
  /** Manual only: the field whose value distinguishes the current content (to
   * remember a pick). Optional; the engine falls back to document.title. */
  manualKey?: Field;
  fields: {
    title?: Field;
    year?: Field;
    season?: Field;
    episode?: Field;
  };
}

export type DraftFieldKey = keyof RecipeDraft["fields"];

/**
 * Best-guess quick-link URL template(s) for the CURRENT page, so the picker can
 * offer to add a "watch on this site" link without a trip to the options page.
 * It's a starting point (heuristic, editable): the id/slug segment of the URL is
 * swapped for a placeholder, and for shows a trailing `…/{id}/{season}/{episode}`
 * or `…/{slug}/{s}-{e}` shape is recognised. AniList anime sites use `{slug}`.
 */
export function deriveQuickLink(draft: RecipeDraft, url: string): LinkTemplates {
  let host: string;
  let path: string;
  try {
    const u = new URL(url);
    host = u.host;
    path = u.pathname.replace(/\/$/, "");
  } catch {
    return {};
  }
  const base = `https://${host}`;
  const isShow =
    draft.mediaType === "show" ||
    draft.fields.season !== undefined ||
    draft.fields.episode !== undefined;

  if (draft.tracker === "anilist") {
    return { anime: `${base}${path.replace(/\/[^/]+$/, "/{slug}")}` };
  }
  if (isShow) {
    const numbered = path.match(/^(.*?)\/\d+\/\d+\/\d+$/); // …/{id}/{season}/{episode}
    if (numbered) return { tv: `${base}${numbered[1]}/{tmdb}/{season}/{episode}` };
    const hyphenated = path.match(/^(.*?)\/[^/]+\/\d+-\d+$/); // …/{slug}/{s}-{e}
    if (hyphenated) return { tv: `${base}${hyphenated[1]}/{slug}/{season}-{episode}` };
    if (/\/\d+$/.test(path)) return { tv: `${base}${path.replace(/\/\d+$/, "/{tmdb}")}` };
    return { tv: `${base}${path.replace(/\/[^/]+$/, "/{slug}")}` };
  }
  // movie: a numeric id → {tmdb}; otherwise a slug → {slug}.
  if (/\/\d+$/.test(path)) return { movie: `${base}${path.replace(/\/\d+$/, "/{tmdb}")}` };
  return { movie: `${base}${path.replace(/\/[^/]+$/, "/{slug}")}` };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex (for a `url` Field) capturing the Nth number in the URL — robust for
 * season/episode in paths like `/tv/273240/1/1` (n=1 → season 1, n=2 → episode
 * 1) or `/episode/the-rookie/1-2` (n=0 → season 1, n=1 → episode 2).
 */
export function urlTokenRegex(ordinal: number): string {
  return `(?:\\D*\\d+){${ordinal}}\\D*(\\d+)`;
}

/**
 * A urlPattern matching the hostname + first path segment (e.g.
 * "cineby\.at/movie"), so a movie recipe doesn't fire on the home/search pages.
 * Hostname-scoped rather than full-URL so it survives the dynamic id segment.
 */
export function suggestUrlPattern(url: string): string {
  try {
    const u = new URL(url);
    const firstSegment = u.pathname.split("/").filter(Boolean)[0];
    const base = firstSegment ? `${u.hostname}/${firstSegment}` : u.hostname;
    return escapeRegex(base);
  } catch {
    return escapeRegex(url);
  }
}

export function emptyDraft(url: string): RecipeDraft {
  let hostname: string | undefined;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = undefined;
  }
  return {
    match: {
      urlPattern: suggestUrlPattern(url),
      hostnames: hostname ? [hostname] : undefined,
    },
    mediaType: "auto",
    tracker: "trakt",
    video: { selector: "video", frame: "auto" },
    manual: false,
    fields: {},
  };
}

/** Reverse of buildRecipe: load a saved recipe back into an editable draft. */
export function recipeToDraft(recipe: Recipe): RecipeDraft {
  return {
    match: {
      urlPattern: recipe.match.urlPattern,
      domFingerprint: recipe.match.domFingerprint,
      hostnames: recipe.match.hostnames,
    },
    mediaType: recipe.mediaType,
    tracker: recipe.tracker,
    video: { selector: recipe.video.selector, frame: recipe.video.frame },
    manual: recipe.extract === undefined,
    manualKey: recipe.manualKey,
    fields: {
      title: recipe.extract?.title,
      year: recipe.extract?.year,
      season: recipe.extract?.season,
      episode: recipe.extract?.episode,
    },
  };
}

/**
 * Whether a saved recipe belongs to this host — used to reload it into the
 * picker for editing, even from a non-media page (homepage) where its urlPattern
 * wouldn't match the current URL. Checks the hostnames hint, then falls back to
 * the escaped hostname appearing in the urlPattern (how the picker builds them).
 */
export function recipeMatchesHost(recipe: Recipe, hostname: string): boolean {
  if (recipe.match.hostnames?.includes(hostname)) return true;
  return recipe.match.urlPattern.includes(escapeRegex(hostname));
}

function firstWorking(candidates: Field[], ctx: EngineContext): Field | undefined {
  for (const field of candidates) {
    if (readField(field, ctx) !== null) return field;
  }
  return undefined;
}

/**
 * Best-effort field detection from page metadata, preferring url/meta/jsonld over
 * dom (per CLAUDE.md conventions: the picker should auto-detect before asking the
 * user to click). Returns only the fields that actually yield a value.
 */
export function autoDetectFields(ctx: EngineContext): RecipeDraft["fields"] {
  const title = firstWorking(
    [
      { source: "meta", selector: "og:title", transforms: ["trim", "collapseSpaces"] },
      { source: "jsonld", selector: "partOfSeries.name", transforms: ["trim", "collapseSpaces"] },
      { source: "jsonld", selector: "name", transforms: ["trim", "collapseSpaces"] },
      { source: "title", transforms: ["trim", "collapseSpaces"] },
    ],
    ctx,
  );
  const season = firstWorking(
    [{ source: "jsonld", selector: "partOfTVSeason.seasonNumber", transforms: ["toInt"] }],
    ctx,
  );
  const episode = firstWorking(
    [{ source: "jsonld", selector: "episodeNumber", transforms: ["toInt"] }],
    ctx,
  );
  const year = firstWorking(
    [
      { source: "jsonld", selector: "datePublished", regex: "(\\d{4})", transforms: ["toInt"] },
      {
        source: "meta",
        selector: "og:video:release_date",
        regex: "(\\d{4})",
        transforms: ["toInt"],
      },
    ],
    ctx,
  );
  return { title, year, season, episode };
}

export type BuildResult = { ok: true; recipe: Recipe } | { ok: false; error: string };

/** Assemble + validate a recipe from a draft. */
export function buildRecipe(draft: RecipeDraft, meta: { id: string; name: string }): BuildResult {
  const base = {
    id: meta.id,
    schemaVersion: SCHEMA_VERSION,
    name: meta.name,
    match: draft.match,
    mediaType: draft.mediaType,
    tracker: draft.tracker,
    video: { selector: draft.video.selector, frame: draft.video.frame },
  };

  // Manual recipe: no extract. An optional manualKey remembers a pick by the
  // page's distinguishing string (filename / room title).
  const candidate = draft.manual
    ? { ...base, ...(draft.manualKey ? { manualKey: draft.manualKey } : {}) }
    : draft.fields.title
      ? {
          ...base,
          extract: {
            title: draft.fields.title,
            year: draft.fields.year,
            season: draft.fields.season,
            episode: draft.fields.episode,
          },
        }
      : null;

  if (!candidate) return { ok: false, error: "Pick a title first." };

  const parsed = RecipeSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid recipe" };
  }
  return { ok: true, recipe: parsed.data };
}

/**
 * Live preview: run the real engine against the page with the current draft.
 * A manual recipe has no extract, so the engine returns its manual guard result
 * ({ ok: false }); the picker presents that as an info note, not an error.
 */
export function previewDraft(draft: RecipeDraft, ctx: EngineContext): ExtractResult {
  const built = buildRecipe(draft, { id: "preview", name: "preview" });
  if (!built.ok) return { ok: false, error: built.error };
  return extract(built.recipe, ctx);
}
