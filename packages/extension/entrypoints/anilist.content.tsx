import { quickLinks } from "@/lib/storage";
import { type QuickLinkItem, mountQuickLinks } from "@/lib/ui/quicklinks";
import { type AniListPageMedia, buildAniListSiteLinks } from "@tmsync/shared";

/**
 * Runs on anilist.co (the AniList analogue of trakt.content). Reads an anime's id
 * + title from the page and injects "watch on <site>" links for every ENABLED
 * AniList quick-link site, deep-linked to the series (or a title search). Mirrors
 * the Trakt quick-links feature.
 *
 * AniList is a Vue SPA: navigating to an anime page client-side never triggers a
 * fresh content-script injection, so a `/anime/*`-only match would only work after
 * a full reload. We match the whole host and (re)mount when the anime changes.
 *
 * We detect that by POLLING `location` rather than `wxt:locationchange`: the latter
 * is unreliable in an isolated content script (history patching doesn't cross JS
 * worlds and the Navigation API events don't fire here), whereas `location` always
 * reflects the real URL from any world. Polling the anime id keeps it cheap and
 * avoids churn when switching sub-tabs of the same anime.
 */
export default defineContentScript({
  matches: ["*://anilist.co/*", "*://www.anilist.co/*"],
  cssInjectionMode: "ui",
  async main(ctx) {
    const sites = (await quickLinks.getValue()).filter((s) => s.enabled && s.tracker === "anilist");
    if (sites.length === 0) return; // nothing to show

    const getItems = (): QuickLinkItem[] => {
      const media = parseAniListPage();
      if (!media) return [];
      const items: QuickLinkItem[] = [];
      for (const s of sites) {
        const links = buildAniListSiteLinks(s, media);
        if (links.direct || links.search) items.push({ name: s.name, ...links });
      }
      return items;
    };

    const animeId = () => location.pathname.match(/\/anime\/(\d+)/)?.[1] ?? null;

    // One quick-links UI at a time; re-created per anime page so its links match
    // the page. `gen` discards a mount whose navigation was superseded mid-await.
    let ui: Awaited<ReturnType<typeof mountQuickLinks>> | undefined;
    let gen = 0;
    const sync = async () => {
      const my = ++gen;
      ui?.remove();
      ui = undefined;
      if (animeId() === null) return; // not an anime page
      const created = await mountQuickLinks(ctx, getItems, {
        // Top of the left info column (above the rankings), so it's visible without
        // scrolling to the "External & Streaming links" block near the bottom. mb-4
        // keeps it off the rankings element below.
        anchor: ".sidebar",
        append: "first",
        class: "mb-4",
      });
      if (my !== gen) return created.remove(); // navigated again while mounting
      ui = created;
    };

    await sync();
    // SPA navigation: re-mount only when the anime id actually changes.
    let lastId = animeId();
    ctx.setInterval(() => {
      const id = animeId();
      if (id === lastId) return;
      lastId = id;
      void sync();
    }, 500);
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
