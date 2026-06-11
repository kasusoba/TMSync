import { quickLinks } from "@/lib/storage";
import { type QuickLinkItem, mountQuickLinks } from "@/lib/ui/quicklinks";
import { type AniListPageMedia, buildAniListSiteLinks } from "@tmsync/shared";

/**
 * Runs on anilist.co anime pages (static, specific host — the AniList analogue of
 * trakt.content). Reads the anime's id + title from the page and injects "watch
 * on <site>" links for every ENABLED AniList quick-link site, deep-linked to the
 * series (or a title search). Mirrors the Trakt quick-links feature.
 */
export default defineContentScript({
  matches: ["*://anilist.co/anime/*", "*://www.anilist.co/anime/*"],
  cssInjectionMode: "ui",
  async main(ctx) {
    const sites = (await quickLinks.getValue()).filter((s) => s.enabled && s.tracker === "anilist");
    if (sites.length === 0) return; // nothing to show

    await mountQuickLinks(
      ctx,
      () => {
        const media = parseAniListPage();
        if (!media) return [];
        const items: QuickLinkItem[] = [];
        for (const s of sites) {
          const links = buildAniListSiteLinks(s, media);
          if (links.direct || links.search) items.push({ name: s.name, ...links });
        }
        return items;
      },
      // Top of the left info column (above the rankings), so it's visible without
      // scrolling to the "External & Streaming links" block near the bottom. mb-4
      // keeps it off the rankings element below.
      { anchor: ".sidebar", append: "first", class: "mb-4" },
    );
  },
});

/** Map the data rows in AniList's sidebar (`.data-set` → type/value) to a lookup. */
function readDataSets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const set of document.querySelectorAll(".data .data-set")) {
    const type = set.querySelector(".type")?.textContent?.trim();
    const value = set.querySelector(".value")?.textContent?.trim();
    if (type && value && !(type in out)) out[type] = value;
  }
  return out;
}

/** Read the anime's AniList id + English/romaji title from the current page. */
function parseAniListPage(): AniListPageMedia | null {
  const idMatch = location.pathname.match(/\/anime\/(\d+)/);
  const anilistId = idMatch ? Number(idMatch[1]) : undefined;

  const data = readDataSets();
  const romaji = data.Romaji || undefined;
  const english = data.English || undefined;
  // Prefer English, then romaji; fall back to the page heading (native title).
  const heading = document.querySelector(".header .content h1")?.textContent?.trim() || undefined;
  const title = english || romaji || heading;

  if (anilistId === undefined && title === undefined) return null;
  return { anilistId, title, romaji };
}
