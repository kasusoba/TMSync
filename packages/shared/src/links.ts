import type { LinkTemplates } from "./schema";

/**
 * Media identified on a Trakt page, used to build an outbound quick link.
 * `type` decides movie vs tv template; season/episode are already resolved per
 * the page level (show → 1/1, season → n/1, episode → n/m).
 */
export interface TraktPageMedia {
  type: "movie" | "tv";
  tmdb?: string;
  imdb?: string;
  title?: string;
  /** Trakt's own URL slug (the SHOW slug for tv) — the reliable {slug} source. */
  slug?: string;
  season?: number;
  episode?: number;
}

/**
 * Anime identified on an AniList page, used to build an outbound quick link.
 * `title` is the display title (English, else romaji); `romaji` is kept separate
 * because some anime sites key off it.
 */
export interface AniListPageMedia {
  anilistId?: number;
  title?: string;
  romaji?: string;
}

/** The links a site can offer for one item: a direct deep link and/or search. */
export interface SiteLinks {
  direct?: string;
  search?: string;
}

/** Lowercase, hyphen-joined slug of a title (e.g. "The Rookie" → "the-rookie"). */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Substitute `{placeholder}` tokens in a template. Returns null if any
 * referenced placeholder is missing/empty — so a `{tmdb}` template is skipped
 * when we couldn't read a TMDB id, rather than producing a broken URL.
 */
export function fillTemplate(
  template: string,
  params: Record<string, string | number | undefined>,
): string | null {
  let missing = false;
  const url = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = params[key];
    if (v === undefined || v === "") {
      missing = true;
      return "";
    }
    return String(v);
  });
  return missing ? null : url;
}

/**
 * Build the outbound links for a site from its templates and the Trakt page
 * media: the id-based `movie`/`tv` deep link (if fillable) and the title-based
 * `search` link (if defined). Placeholders: {tmdb} {imdb} {season} {episode}
 * {title} (URL-encoded), {slug} (clean, year-free) and {slugyear} (Trakt's raw
 * slug, which may include a disambiguation year).
 */
export function buildSiteLinks(links: LinkTemplates, media: TraktPageMedia): SiteLinks {
  const titleSlug = media.title !== undefined ? slugify(media.title) : undefined;
  // {slug}: a clean, year-free slug. Trakt appends a disambiguation year to BOTH
  // movie ("terrifier-3-2024") and show ("invincible-2021") slugs, which most
  // sites omit. For movies the title slugifies cleanly (and keeps a year that is
  // part of the title, e.g. "blade-runner-2049"). For tv the og:title is the
  // EPISODE, so strip a trailing -YYYY off Trakt's show slug. {slugyear} keeps
  // Trakt's raw slug for sites that mirror it.
  const bareSlug = media.slug?.replace(/-(?:19|20)\d{2}$/, "");
  const slug = media.type === "movie" ? (titleSlug ?? bareSlug) : (bareSlug ?? titleSlug);
  const params = {
    tmdb: media.tmdb,
    imdb: media.imdb,
    title: media.title !== undefined ? encodeURIComponent(media.title) : undefined,
    slug,
    slugyear: media.slug,
    season: media.season,
    episode: media.episode,
  };
  const out: SiteLinks = {};
  const directTpl = media.type === "movie" ? links.movie : links.tv;
  if (directTpl) {
    const url = fillTemplate(directTpl, params);
    if (url) out.direct = url;
  }
  if (links.search) {
    const url = fillTemplate(links.search, params);
    if (url) out.search = url;
  }
  return out;
}

/**
 * Build the outbound links for an anime site from its templates and an AniList
 * page's media: the `anime` deep link (if fillable) and the title-based `search`
 * link. Placeholders: {anilistId}, {title} (URL-encoded English/romaji), {romaji}
 * (URL-encoded), {slug} (clean, hyphen-joined).
 */
export function buildAniListSiteLinks(links: LinkTemplates, media: AniListPageMedia): SiteLinks {
  const params = {
    anilistId: media.anilistId,
    title: media.title !== undefined ? encodeURIComponent(media.title) : undefined,
    romaji: media.romaji !== undefined ? encodeURIComponent(media.romaji) : undefined,
    slug: media.title !== undefined ? slugify(media.title) : undefined,
  };
  const out: SiteLinks = {};
  if (links.anime) {
    const url = fillTemplate(links.anime, params);
    if (url) out.direct = url;
  }
  if (links.search) {
    const url = fillTemplate(links.search, params);
    if (url) out.search = url;
  }
  return out;
}
