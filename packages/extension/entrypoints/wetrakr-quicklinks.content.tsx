import { stampBuild } from "@/lib/diagnostics/build-stamp";
import { quickLinks, quickLinksEnabled } from "@/lib/storage";
import { parseWetrakrPath } from "@/lib/trackers/wetrakr/page";
import { type QuickLinkItem, keepQuickLinks } from "@/lib/ui/quicklinks";
import { sendMessage } from "@/messaging";
import { type TraktPageMedia, siteQuickLinks } from "@tmsync/shared";

/**
 * Runs on wetrakr.com (the WeTrakr analogue of trakt-quicklinks.content). Injects
 * "watch on <site>" links for every ENABLED movie and TV quick-link site, the same
 * links trakt.tv shows. The title comes from the URL and the WeTrakr API, never from
 * the page's HTML: WeTrakr's terms forbid scraping their site.
 *
 * Registered at runtime, only once the user granted wetrakr.com (asked with the
 * API on Connect), so the install manifest gains no host (constraint #5). WeTrakr is
 * an Angular SPA: like AniList, we poll `location` and re-mount on a new title.
 */
export default defineContentScript({
  matches: ["*://wetrakr.com/*"],
  registration: "runtime",
  cssInjectionMode: "ui",
  async main(ctx) {
    stampBuild();
    if (!(await quickLinksEnabled.getValue())) return; // quick links turned off in Options

    const sites = (await quickLinks.getValue()).filter(
      (s) => s.enabled && (s.tracker ?? "trakt") === "trakt",
    );
    if (sites.length === 0) return; // nothing to show

    let ui: ReturnType<typeof keepQuickLinks> | undefined;
    let gen = 0;
    const sync = async () => {
      const my = ++gen;
      ui?.remove();
      ui = undefined;
      const page = parseWetrakrPath(location.pathname);
      if (!page) return;
      const info = await sendMessage("wetrakrPageMedia", { type: page.type, id: page.id });
      if (my !== gen || !info) return;
      // A show page links episode 1 of season 1, a season page its first episode.
      const media: TraktPageMedia = {
        type: page.type === "movie" ? "movie" : "tv",
        tmdb: info.tmdb !== undefined ? String(info.tmdb) : undefined,
        imdb: info.imdb,
        title: info.title,
        season: page.type === "show" ? (page.season ?? 1) : undefined,
        episode: page.type === "show" ? (page.episode ?? 1) : undefined,
      };
      const items = (): QuickLinkItem[] => siteQuickLinks(sites, media);
      // In the left column, under the page's own "Where to watch" box (as on
      // app.trakt.tv), else under the poster when the title has no such box.
      ui = keepQuickLinks(ctx, items, { anchor: wetrakrAnchor, class: "mt-4" });
    };

    await sync();
    // SPA navigation: re-mount when the page's title or episode changes.
    let last = location.pathname;
    ctx.setInterval(() => {
      if (location.pathname === last) return;
      last = location.pathname;
      void sync();
    }, 500);
  },
});

/** The page's "Where to watch" box, else the poster. Layout only: no data is read
 * from the page (WeTrakr's terms). */
function wetrakrAnchor(): Element | null {
  return (
    document.querySelector("content-header we-item-info.sidebar-streaming") ??
    document.querySelector("content-header .detail-grid__poster")
  );
}
