import { stampBuild } from "@/lib/diagnostics/build-stamp";
import { quickLinkSlugs, quickLinks, quickLinksEnabled } from "@/lib/storage";
import { type QuickLinkItem, keepQuickLinks } from "@/lib/ui/quicklinks";
import { sendMessage } from "@/messaging";
import {
  type AniListPageMedia,
  type TraktPageMedia,
  animeQuickLinks,
  siteQuickLinks,
} from "@tmsync/shared";

/**
 * Runs on simkl.com. A movie or TV page gets the movie and TV quick links (the ones
 * trakt.tv shows), an anime page the anime ones (the ones anilist.co shows). The ids
 * come from Simkl's own external links on the page, like the classic trakt.tv
 * script, so a page view costs no Simkl API call (its daily quota is shared).
 *
 * Registered at runtime, only while the user holds simkl.com (asked on Simkl's
 * Connect), so the install manifest gains no host (constraint #5).
 */
export default defineContentScript({
  matches: ["*://simkl.com/*"],
  registration: "runtime",
  cssInjectionMode: "ui",
  async main(ctx) {
    stampBuild();
    if (!(await quickLinksEnabled.getValue())) return; // quick links turned off in Options

    const all = (await quickLinks.getValue()).filter((s) => s.enabled);
    const movieSites = all.filter((s) => (s.tracker ?? "trakt") === "trakt");
    const animeSites = all.filter((s) => s.tracker === "anilist");

    let ui: ReturnType<typeof keepQuickLinks> | undefined;
    let gen = 0;
    const sync = async () => {
      const my = ++gen;
      ui?.remove();
      ui = undefined;
      const page = parseSimklPath(location.pathname);
      if (!page) return;
      let items: () => QuickLinkItem[];
      if (page.section === "anime") {
        if (animeSites.length === 0) return;
        const ids = readAnimeIds();
        const found = await sendMessage("anilistPageMedia", ids).catch(() => null);
        if (my !== gen) return;
        const media: AniListPageMedia = found ?? { anilistId: ids.anilist, title: pageTitle() };
        const slugs = await quickLinkSlugs.getValue();
        items = () => animeQuickLinks(animeSites, media, slugs);
      } else {
        if (movieSites.length === 0) return;
        // Read on each mount: the external links render with the page.
        items = () => siteQuickLinks(movieSites, readMedia(page));
      }
      // Right column, above the ratings of friends and members.
      ui = keepQuickLinks(ctx, items, {
        anchor: () => document.querySelector("table.SimklTVRightBlockFriendsRatingsBl"),
        append: "before",
        class: "mb-4",
      });
    };

    await sync();
    // Simkl can swap pages in place: re-mount when the path changes.
    let last = location.pathname;
    ctx.setInterval(() => {
      if (location.pathname === last) return;
      last = location.pathname;
      void sync();
    }, 500);
  },
});

interface SimklPage {
  section: "movies" | "tv" | "anime";
  season?: number;
  episode?: number;
}

/** `/movies/{id}`, `/tv/{id}`, `/anime/{id}`, with an optional `/season-N/episode-M`. */
function parseSimklPath(path: string): SimklPage | null {
  const m = /^\/(movies|tv|anime)\/(\d+)/.exec(path);
  if (!m) return null;
  const season = /\/season-(\d+)/.exec(path)?.[1];
  const episode = /\/episode-(\d+)/.exec(path)?.[1];
  return {
    section: m[1] as SimklPage["section"],
    season: season !== undefined ? Number(season) : undefined,
    episode: episode !== undefined ? Number(episode) : undefined,
  };
}

/** The first id an external link on the page carries, by the link's URL pattern. */
function linkId(pattern: RegExp): string | undefined {
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const id = pattern.exec(a.href)?.[1];
    if (id) return id;
  }
  return undefined;
}

/** The title without Simkl's year suffix: "The Office (US) (TV Series 2005 - 2013)". */
function pageTitle(): string | undefined {
  const raw =
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || document.title;
  return raw.replace(/\s*\([^()]*\d{4}[^()]*\)\s*$/, "").trim() || undefined;
}

/** A movie or TV page's media. A show page links S1E1, a season page its first episode. */
function readMedia(page: SimklPage): TraktPageMedia {
  const movie = page.section === "movies";
  return {
    type: movie ? "movie" : "tv",
    tmdb: linkId(movie ? /themoviedb\.org\/movie\/(\d+)/ : /themoviedb\.org\/tv\/(\d+)/),
    imdb: linkId(/imdb\.com\/title\/(tt\d+)/),
    title: pageTitle(),
    season: movie ? undefined : (page.season ?? 1),
    episode: movie ? undefined : (page.episode ?? 1),
  };
}

/** An anime page's AniList and MAL ids, from its external links. */
function readAnimeIds(): { anilist?: number; mal?: number } {
  const anilist = linkId(/anilist\.co\/anime\/(\d+)/);
  const mal = linkId(/myanimelist\.net\/anime\/(\d+)/);
  return {
    anilist: anilist !== undefined ? Number(anilist) : undefined,
    mal: mal !== undefined ? Number(mal) : undefined,
  };
}
