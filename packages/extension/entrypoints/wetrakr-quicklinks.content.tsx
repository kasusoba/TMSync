import { stampBuild } from "@/lib/diagnostics/build-stamp";
import { quickLinks, quickLinksEnabled } from "@/lib/storage";
import { parseWetrakrPath } from "@/lib/trackers/wetrakr/page";
import { type QuickLinkItem, mountQuickLinks } from "@/lib/ui/quicklinks";
import { sendMessage } from "@/messaging";
import { type TraktPageMedia, buildSiteLinks } from "@tmsync/shared";

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

    let ui: Awaited<ReturnType<typeof mountQuickLinks>> | undefined;
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
      const items = (): QuickLinkItem[] =>
        sites.flatMap((s) => {
          const links = buildSiteLinks(s, media);
          return links.direct || links.search ? [{ name: s.name, ...links }] : [];
        });
      // Under the title header of a movie, show, season, or episode page.
      const created = await mountQuickLinks(ctx, items, {
        anchor: "content-header",
        append: "after",
        class: "my-3",
      });
      if (my !== gen) return created.remove(); // navigated again while mounting
      ui = created;
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
