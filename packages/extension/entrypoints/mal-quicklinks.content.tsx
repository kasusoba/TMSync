import { stampBuild } from "@/lib/diagnostics/build-stamp";
import { quickLinkSlugs, quickLinks, quickLinksEnabled } from "@/lib/storage";
import { type QuickLinkItem, keepQuickLinks } from "@/lib/ui/quicklinks";
import { sendMessage } from "@/messaging";
import { type AniListPageMedia, animeQuickLinks } from "@tmsync/shared";

/**
 * Runs on myanimelist.net (the MAL analogue of anilist-quicklinks.content). Injects
 * "watch on <site>" links for every ENABLED anime quick-link site. The anime
 * templates key off AniList, so the MAL id from the URL is bridged to its AniList
 * entry (1:1, `idMal`) through the background.
 *
 * Registered at runtime, only while the user holds myanimelist.net (asked on MAL's
 * Connect), so the install manifest gains no host (constraint #5).
 */
export default defineContentScript({
  matches: ["*://myanimelist.net/*"],
  registration: "runtime",
  cssInjectionMode: "ui",
  async main(ctx) {
    stampBuild();
    if (!(await quickLinksEnabled.getValue())) return; // quick links turned off in Options

    const sites = (await quickLinks.getValue()).filter((s) => s.enabled && s.tracker === "anilist");
    if (sites.length === 0) return; // nothing to show

    const mal = Number(location.pathname.match(/^\/anime\/(\d+)/)?.[1]);
    if (!mal) return; // not an anime page (MAL pages are full loads, no SPA nav)

    // AniList's titles, else MAL's own heading, so a search link still works when
    // AniList has no entry for it.
    const media: AniListPageMedia = (await sendMessage("anilistPageMedia", { mal })) ?? {
      title: malTitle(),
      romaji: malTitle(),
    };
    const slugs = await quickLinkSlugs.getValue();
    const items = (): QuickLinkItem[] => animeQuickLinks(sites, media, slugs);

    // Left column, under the share icons, above "Alternative Titles".
    keepQuickLinks(ctx, items, {
      anchor: () => document.querySelector(".leftside .js-sns-icon-container"),
      class: "mt-3",
      // MAL is light unless the user turned on its dark mode.
      variant: document.querySelector("html.dark-mode, body.dark-mode") ? "dark" : "light",
    });
  },
});

/** The anime's title as MAL's page heading shows it (romaji). */
function malTitle(): string | undefined {
  return (
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content?.trim() ||
    undefined
  );
}
