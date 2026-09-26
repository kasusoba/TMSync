import { hostText, normalizeHost } from "./hosts";
import type { LinkTemplates, Tracker } from "./schema";

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

/** One quick-link placeholder: the `{token}`, what it is, and a concrete example. */
export interface PlaceholderDoc {
  token: string;
  desc: string;
  example: string;
}

/**
 * Placeholders usable in a Trakt-page (movie/tv) quick-link template. Single
 * source of truth for the editor + options help so the two never drift.
 */
export const TRAKT_PLACEHOLDERS: readonly PlaceholderDoc[] = [
  { token: "tmdb", desc: "TMDB id", example: "603" },
  { token: "imdb", desc: "IMDb id", example: "tt0133093" },
  { token: "title", desc: "URL-encoded title", example: "The%20Matrix" },
  { token: "slug", desc: "clean slug, year stripped", example: "the-matrix" },
  { token: "slugyear", desc: "Trakt slug, may keep a year", example: "the-matrix-1999" },
  { token: "season", desc: "season number (tv)", example: "1" },
  { token: "episode", desc: "episode number (tv)", example: "5" },
];

/** Placeholders usable in an AniList-page (anime) quick-link template. */
export const ANILIST_PLACEHOLDERS: readonly PlaceholderDoc[] = [
  { token: "anilist", desc: "AniList id", example: "21" },
  { token: "title", desc: "URL-encoded title", example: "Frieren" },
  { token: "romaji", desc: "URL-encoded romaji", example: "Sousou%20no%20Frieren" },
  { token: "slug", desc: "series slug", example: "frieren" },
  {
    token: "canonical",
    desc: "site's real slug, from a prior watch",
    example: "sousou-no-frieren",
  },
];

/** Render a placeholder list as tooltip text: one `{token} → example` per line. */
export function placeholderHint(list: readonly PlaceholderDoc[]): string {
  return list.map((p) => `{${p.token}} → ${p.example}`).join("\n");
}

/**
 * The tracker's OWN website URL for a resolved item — so the now-playing UI can
 * "open on <tracker>" in a new tab. Each site takes a numeric id in the path (Trakt
 * redirects it to the canonical slug page), so the resolved id is enough:
 *   Trakt movie:   trakt.tv/movies/{id}
 *   Trakt show:    trakt.tv/shows/{id}
 *   Trakt episode: trakt.tv/shows/{id}/seasons/{s}/episodes/{e}  (when s+e known)
 *   AniList:       anilist.co/anime/{id}  (no per-episode pages, always the entry)
 *   MyAnimeList:   myanimelist.net/anime/{id}  (the entry, like AniList)
 *   Simkl:         simkl.com/{movies|tv}/{id}  (a guess from the media type; the
 *                  real page, `anime` included, comes from the write that names it)
 */
export function trackerItemUrl(tracker: Tracker, id: number, opts?: ItemUrlOpts): string {
  return ITEM_URL[tracker](id, opts ?? {});
}

interface ItemUrlOpts {
  mediaType?: "movie" | "show";
  season?: number;
  episode?: number;
}

/** One URL builder per tracker. A record, so a new tracker must add its own (no
 * fall-through to Trakt). */
const ITEM_URL: Record<Tracker, (id: number, o: ItemUrlOpts) => string> = {
  trakt: (id, o) => {
    if (o.mediaType === "movie") return `https://trakt.tv/movies/${id}`;
    const base = `https://trakt.tv/shows/${id}`;
    return o.season !== undefined && o.episode !== undefined
      ? `${base}/seasons/${o.season}/episodes/${o.episode}`
      : base;
  },
  anilist: (id) => `https://anilist.co/anime/${id}`,
  mal: (id) => `https://myanimelist.net/anime/${id}`,
  simkl: (id, o) => `https://simkl.com/${o.mediaType === "movie" ? "movies" : "tv"}/${id}`,
};

/** Split an absolute template into host and path. Null for a path template.
 * Textual, not URL(): a template holds `{placeholder}` braces, and URL() would
 * percent-encode them into the path. */
function splitTemplate(template: string): { host: string; path: string } | null {
  const parts = /^https?:\/\/([^/?#]+)(.*)$/i.exec(template);
  return parts ? { host: hostText(parts[1] ?? ""), path: parts[2] || "/" } : null;
}

/** The site a quick link points at: its `host`, else the host of its first absolute template. */
export function linkHost(links: LinkTemplates): string {
  if (links.host) return hostText(links.host);
  for (const tpl of [links.movie, links.tv, links.anime, links.search]) {
    const split = tpl ? splitTemplate(tpl) : null;
    if (split) return split.host;
  }
  return "";
}

/**
 * Point a quick link at `host`: set the field and turn every absolute template
 * that used the OLD host into a path, so one field now holds the domain. A
 * template on some other host is left alone (it was pointed there on purpose).
 */
export function withLinkHost<T extends LinkTemplates>(links: T, host: string): T {
  const previous = normalizeHost(linkHost(links));
  const relative = (tpl?: string) => {
    const split = tpl ? splitTemplate(tpl) : null;
    return split && normalizeHost(split.host) === previous ? split.path : tpl;
  };
  return {
    ...links,
    host: hostText(host),
    movie: relative(links.movie),
    tv: relative(links.tv),
    anime: relative(links.anime),
    search: relative(links.search),
  };
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
    const url = fillSiteTemplate(directTpl, links.host, params);
    if (url) out.direct = url;
  }
  if (links.search) {
    const url = fillSiteTemplate(links.search, links.host, params);
    if (url) out.search = url;
  }
  return out;
}

/**
 * Make a template absolute against the site's `host`, then fill its placeholders.
 * A path template with no host to join to yields null, so the link is skipped
 * rather than rendered broken.
 */
function fillSiteTemplate(
  template: string,
  host: string | undefined,
  params: Record<string, string | number | undefined>,
): string | null {
  if (splitTemplate(template)) return fillTemplate(template, params);
  if (!host) return null;
  const path = template.startsWith("/") ? template : `/${template}`;
  return fillTemplate(`https://${host}${path}`, params);
}

/**
 * Build the outbound links for an anime site from its templates and an AniList
 * page's media: the `anime` deep link (if fillable) and the title-based `search`
 * link. Placeholders: {anilist}, {title} (URL-encoded English/romaji), {romaji}
 * (URL-encoded), {slug}, {canonical}. `{anilistId}` is still accepted as a
 * back-compat alias for `{anilist}` (the token was renamed for consistency with
 * the bare-id {tmdb}/{imdb} on the Trakt side).
 *
 * `canonical` is the site's REAL series slug, captured from a prior watch (the
 * crosswalk). When present it fills both `{canonical}` and `{slug}` — so a
 * `…/{slug}` template hits the exact page instead of a guessed title-slug. Absent
 * ⇒ `{slug}` falls back to slugify(title), which most anime sites won't match, so
 * the link is typically skipped in favour of `search`.
 */
export function buildAniListSiteLinks(
  links: LinkTemplates,
  media: AniListPageMedia,
  canonical?: string,
): SiteLinks {
  const params = {
    anilist: media.anilistId,
    anilistId: media.anilistId, // back-compat alias: {anilistId} was the pre-rename token
    title: media.title !== undefined ? encodeURIComponent(media.title) : undefined,
    romaji: media.romaji !== undefined ? encodeURIComponent(media.romaji) : undefined,
    slug: canonical ?? (media.title !== undefined ? slugify(media.title) : undefined),
    canonical,
  };
  const out: SiteLinks = {};
  if (links.anime) {
    const url = fillSiteTemplate(links.anime, links.host, params);
    if (url) out.direct = url;
  }
  if (links.search) {
    const url = fillSiteTemplate(links.search, links.host, params);
    if (url) out.search = url;
  }
  return out;
}
