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
  recipeTrackers,
} from "@tmsync/shared";

/**
 * An in-progress recipe being assembled by the element picker. Mirrors the
 * recipe shape but with every extracted field optional while the user builds it.
 */
export interface RecipeDraft {
  match: { urlPattern: string; domFingerprint?: string; hostnames?: string[] };
  mediaType: "auto" | "movie" | "show";
  /** MULTI-TRACK (docs/MULTI-TRACK.md): the set of trackers to record to — the
   * user's independent toggles (a pluggable list; more trackers may be added).
   * Which one is "native" (recorded directly) vs "derived" (mapped via the
   * anime-map crosswalk) is inferred at runtime from the scraped fields, NOT
   * chosen here. Must have ≥1 to save. */
  trackers: Tracker[];
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
    /** TMDB id (Trakt only) — exact resolution, no title ambiguity. */
    tmdbId?: Field;
  };
}

export type DraftFieldKey = keyof RecipeDraft["fields"];

/**
 * Best-guess quick-link URL template(s) from a page URL, so the popup can pre-fill
 * a "watch on this site" link. It's a starting point (heuristic, editable): the
 * id/slug segment is swapped for a placeholder, and for shows a trailing
 * `…/{id}/{season}/{episode}` or `…/{slug}/{s}-{e}` shape is recognised. AniList
 * anime sites use `{slug}`. `isShow` is a hint (the popup may not know).
 */
export function deriveQuickLink(url: string, tracker: Tracker, isShow = false): LinkTemplates {
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

  if (tracker === "anilist") {
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

/** A number chip in a picked string, with its positional ordinal (0-based). */
export type NumberPart = { text: string } | { num: string; ordinal: number };

/**
 * Split arbitrary text into literal runs + numbered chips (in order) — so the
 * picker can ask "which number is the episode?" when a DOM element packs several
 * (e.g. "Teach You a Lesson: 1x6 – Episode 6" → season=1, episode=6, both via
 * {@link urlTokenRegex} by ordinal). Same idea as the URL chips, on element text.
 */
export function splitNumbers(text: string): NumberPart[] {
  const parts: NumberPart[] = [];
  let last = 0;
  let ordinal = 0;
  for (const m of text.matchAll(/\d+/g)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ text: text.slice(last, idx) });
    parts.push({ num: m[0], ordinal: ordinal++ });
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** How many distinct numbers a string holds — gates whether the picker must ask. */
export function countNumbers(text: string): number {
  return (text.match(/\d+/g) ?? []).length;
}

/**
 * Regex (for a `url` Field) capturing a query param's number by NAME — e.g.
 * `?type=tv&id=85552&season=1&episode=1` → `[?&]season=(\d+)`. More robust than
 * the positional {@link urlTokenRegex} when the value lives in a query string
 * (where an id number would throw off positional counting).
 */
export function queryParamRegex(key: string): string {
  return `[?&]${escapeRegex(key)}=(\\d+)`;
}

/** Separators a site uses in its page <title> (e.g. "Rive | Watch | Title", or
 * "Michael - bCine"). The spaced ASCII hyphen comes last and is space-padded so
 * it doesn't split hyphenated titles like "Spider-Man". */
const TITLE_SEPARATORS = ["|", "·", "—", "–", "•", " - "] as const;

/**
 * Split a page title into trimmed segments by its delimiter — so the picker can
 * offer "use the Nth part of the tab title" when the real title is only in
 * `document.title` (common on SPA players whose `og:title` is a static site name).
 */
export function splitTitle(title: string): { separator: string; parts: string[] } {
  for (const sep of TITLE_SEPARATORS) {
    if (title.includes(sep)) {
      const parts = title
        .split(sep)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 1) return { separator: sep, parts };
    }
  }
  const only = title.trim();
  return { separator: "", parts: only ? [only] : [] };
}

/**
 * Regex (for a `title` Field) capturing the Nth `separator`-delimited segment of
 * the page title — index-based, so it generalises across pages on the same site
 * ("Rive | Watch | X" → index 2 captures X; "X - bCine" → index 0 captures X).
 * Splits on the LITERAL separator (lazy), so it works for multi-char separators
 * like " - " (a char-class approach can't). Leading/trailing space is trimmed by
 * the field's transforms.
 */
export function titleSegmentRegex(separator: string, index: number): string {
  const s = escapeRegex(separator);
  return `^(?:.*?${s}){${index}}(.*?)(?:${s}|$)`;
}

/**
 * Best-guess the TMDB-id field from a URL — these sites almost always carry it
 * (`/movie/693134`, `/tv/276161/1/2`, `?id=502356`). Prefers a named query param,
 * then the first number after a movie/tv/watch/series/show segment. The id is the
 * strongest identity, so auto-filling it makes resolution exact by default.
 */
export function detectTmdbIdField(url: string): Field | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  for (const key of ["tmdb", "tmdbid", "tmdb_id", "id"]) {
    const v = u.searchParams.get(key);
    if (v && /^\d+$/.test(v)) {
      return { source: "url", regex: queryParamRegex(key), group: 1, transforms: ["toInt"] };
    }
  }
  if (/\/(?:movie|tv|watch|series|show)\/\d+/i.test(u.pathname)) {
    return {
      source: "url",
      regex: "/(?:movie|tv|watch|series|show)/(\\d+)",
      group: 1,
      transforms: ["toInt"],
    };
  }
  return undefined;
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
    trackers: ["trakt"],
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
    trackers: recipeTrackers(recipe),
    video: { selector: recipe.video.selector, frame: recipe.video.frame },
    manual: recipe.extract === undefined,
    manualKey: recipe.manualKey,
    fields: {
      title: recipe.extract?.title,
      year: recipe.extract?.year,
      season: recipe.extract?.season,
      episode: recipe.extract?.episode,
      tmdbId: recipe.extract?.tmdbId,
    },
  };
}

/**
 * A friendly default recipe name from a hostname. For a bare domain or a `www.`
 * one, Capitalize the second-level label ("www.miruro.to" / "cineby.at" →
 * "Miruro" / "Cineby"). When a real subdomain remains ("watch.example.com"), keep
 * the full hostname — the bare label alone would be ambiguous. (Compound TLDs like
 * "example.co.uk" fall into the keep-full branch; rare for these sites.)
 */
export function defaultRecipeName(hostname: string): string {
  const bare = hostname.replace(/^www\./i, "");
  const labels = bare.split(".");
  if (labels.length > 2) return hostname; // has a subdomain → keep the host as-is
  const label = labels[0] || hostname;
  return label.charAt(0).toUpperCase() + label.slice(1);
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
  const tmdbId = detectTmdbIdField(ctx.url);
  return { title, year, season, episode, tmdbId };
}

export type BuildResult = { ok: true; recipe: Recipe } | { ok: false; error: string };

/** Assemble + validate a recipe from a draft. */
export function buildRecipe(draft: RecipeDraft, meta: { id: string; name: string }): BuildResult {
  // The native hint = the tracker whose numbering the scraped fields already speak
  // (a tmdbId or a season ⇒ TMDB/Trakt; else a bare linear episode ⇒ AniList). The
  // runtime re-infers this per watch; we persist it as the legacy `tracker` field.
  const trackers = draft.trackers.length ? draft.trackers : (["trakt"] as Tracker[]);
  const nativeHint: Tracker = draft.fields.tmdbId || draft.fields.season ? "trakt" : "anilist";
  const base = {
    id: meta.id,
    schemaVersion: SCHEMA_VERSION,
    name: meta.name,
    match: draft.match,
    mediaType: draft.mediaType,
    // Single tracker ⇒ legacy `tracker` only (recipe looks unchanged). Multi ⇒
    // `trackers` is authoritative + `tracker` carries the native hint for back-compat.
    tracker: (trackers.length === 1 ? trackers[0] : nativeHint) ?? nativeHint,
    ...(trackers.length > 1 ? { trackers } : {}),
    video: { selector: draft.video.selector, frame: draft.video.frame },
  };

  // A movie has no season/episode — drop them even if a stale draft (or a
  // mis-pick) carries them, so the recipe can't later be resolved as a show.
  const isMovie = draft.mediaType === "movie";

  // Manual recipe: no extract. An optional manualKey remembers a pick by the
  // page's distinguishing string (filename / room title).
  const candidate = draft.manual
    ? { ...base, ...(draft.manualKey ? { manualKey: draft.manualKey } : {}) }
    : draft.fields.title || draft.fields.tmdbId
      ? {
          ...base,
          extract: {
            title: draft.fields.title,
            year: draft.fields.year,
            season: isMovie ? undefined : draft.fields.season,
            episode: isMovie ? undefined : draft.fields.episode,
            tmdbId: draft.fields.tmdbId,
          },
        }
      : null;

  if (!candidate) return { ok: false, error: "Pick a title or a TMDB id first." };

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
