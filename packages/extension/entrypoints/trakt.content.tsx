import { quickLinks } from "@/lib/storage";
import { type QuickLinkItem, mountQuickLinks } from "@/lib/ui/quicklinks";
import { type TraktPageMedia, buildSiteLinks } from "@tmsync/shared";

/**
 * Runs on Trakt's web app. Reads the media + ids from the page and injects
 * "watch on <site>" links for every ENABLED Trakt quick-link site, deep-linked to
 * the matching movie / SxEx. Supports BOTH the classic site (trakt.tv) and the new
 * SvelteKit app (app.trakt.tv) — they have different DOMs, so the parser + anchor
 * are chosen by host.
 */
export default defineContentScript({
  matches: ["*://trakt.tv/*", "*://www.trakt.tv/*", "*://app.trakt.tv/*"],
  cssInjectionMode: "ui",
  async main(ctx) {
    // Only Trakt-tracker quick links inject on Trakt pages (AniList ones show on
    // anilist.co — see anilist.content.tsx). Undefined tracker defaults to trakt.
    const sites = (await quickLinks.getValue()).filter(
      (s) => s.enabled && (s.tracker ?? "trakt") === "trakt",
    );
    if (sites.length === 0) return; // nothing to show

    const isApp = location.hostname.endsWith("app.trakt.tv");
    const parse = isApp ? parseAppTraktPage : parseTraktPage;

    await mountQuickLinks(
      ctx,
      () => {
        const media = parse();
        if (!media) return [];
        const items: QuickLinkItem[] = [];
        for (const s of sites) {
          const links = buildSiteLinks(s, media);
          if (links.direct || links.search) items.push({ name: s.name, ...links });
        }
        return items;
      },
      isApp
        ? // New app: place our links right AFTER the whole "Where to Watch"
          // section (i.e. below the providers, above Sentiment), headerless, with
          // gaps. We insert AFTER the section — not inside its provider list,
          // which has a fixed height and would overlap the next section.
          { anchor: whereToWatchAnchor, append: "after", label: null, class: "my-3" }
        : { anchor: "ul.external", append: "after" },
    );
  },
});

/**
 * Resolve the "Where to Watch" section element on app.trakt.tv (its title is
 * text, not a stable class, so we match it). Returns null until the section is
 * present — so autoMount WAITS for it rather than dropping our row at the bottom
 * of the column (below Sentiment).
 */
function whereToWatchAnchor(): Element | null {
  const root = document.querySelector(".trakt-summary-contextual-content");
  if (!root) return null;
  for (const title of root.querySelectorAll(".shadow-list-title")) {
    if (title.textContent?.trim().toLowerCase() === "where to watch") {
      const section = title.closest("section");
      if (section) return section;
    }
  }
  return null;
}

// --- classic trakt.tv ---

/** Read TMDB/IMDB ids from Trakt's own external-links block. */
function readIds(): { tmdb?: string; imdb?: string } {
  const href = (sel: string) =>
    document.querySelector<HTMLAnchorElement>(sel)?.getAttribute("href") ?? "";
  const tmdb = href("#external-link-tmdb").match(/(?:movie|tv)\/(\d+)/)?.[1];
  const imdb = href("#external-link-imdb").match(/(tt\d+)/)?.[1];
  return { tmdb, imdb };
}

/** Bare title for the search fallback (strip Trakt's suffix + a trailing year). */
function readTitle(): string | undefined {
  const og = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content;
  const raw = (og || document.title)
    .replace(/\s*[—–-]\s*Trakt.*$/i, "")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .trim();
  return raw || undefined;
}

/**
 * Map the current classic Trakt page to outbound media: movie → movie; show →
 * S1E1; season → S{n}E1; episode → S{n}E{m}.
 */
function parseTraktPage(): TraktPageMedia | null {
  const path = location.pathname;
  const ids = readIds();
  const title = readTitle();

  const movie = path.match(/^\/movies\/([^/]+)/);
  if (movie) return { type: "movie", slug: movie[1], ...ids, title };

  // For tv the show slug is the FIRST path segment — use it for {slug} so links
  // key off the show, not the episode/season title.
  const show = path.match(/^\/shows\/([^/]+)/);
  if (!show) return null;
  const slug = show[1];

  let m = path.match(/^\/shows\/[^/]+\/seasons\/(\d+)\/episodes\/(\d+)/);
  if (m) return { type: "tv", slug, season: Number(m[1]), episode: Number(m[2]), ...ids, title };
  m = path.match(/^\/shows\/[^/]+\/seasons\/(\d+)/);
  if (m) return { type: "tv", slug, season: Number(m[1]), episode: 1, ...ids, title };
  return { type: "tv", slug, season: 1, episode: 1, ...ids, title };
}

// --- new app.trakt.tv (SvelteKit) ---

/**
 * Map the current app.trakt.tv page to outbound media. The new app exposes the
 * slug (URL), the title, and an IMDB id (ratings link), plus season/episode from
 * the path/query — but NOT a TMDB id, so {tmdb}-only templates fall back to
 * search there. Shapes: `/movies/{slug}`, `/shows/{slug}` (+ `?season=N`),
 * `/shows/{slug}/seasons/{s}` and `…/seasons/{s}/episodes/{e}`.
 */
function parseAppTraktPage(): TraktPageMedia | null {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  const title =
    document.querySelector('[data-testid="summary-media-title"]')?.textContent?.trim() ||
    document.querySelector("main h1")?.textContent?.trim() ||
    undefined;
  const imdb = document
    .querySelector<HTMLAnchorElement>('a[href*="imdb.com/title/"]')
    ?.href.match(/(tt\d+)/)?.[1];
  const ids = { imdb };

  const movie = path.match(/^\/movies\/([^/?]+)/);
  if (movie) return { type: "movie", slug: movie[1], ...ids, title };

  const show = path.match(/^\/shows\/([^/?]+)/);
  if (!show) return null;
  const slug = show[1];

  let m = path.match(/^\/shows\/[^/]+\/seasons\/(\d+)\/episodes\/(\d+)/);
  if (m) return { type: "tv", slug, season: Number(m[1]), episode: Number(m[2]), ...ids, title };
  m = path.match(/^\/shows\/[^/]+\/seasons\/(\d+)/);
  if (m) return { type: "tv", slug, season: Number(m[1]), episode: 1, ...ids, title };
  const season = Number(params.get("season")) || 1;
  return { type: "tv", slug, season, episode: 1, ...ids, title };
}
