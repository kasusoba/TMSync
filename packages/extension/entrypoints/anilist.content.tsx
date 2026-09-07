import { stampBuild } from "@/lib/diagnostics/build-stamp";
import { quickLinkSlugs, quickLinks } from "@/lib/storage";
import { type QuickLinkItem, mountQuickLinks } from "@/lib/ui/quicklinks";
import { type AniListPageMedia, buildAniListSiteLinks } from "@tmsync/shared";

/** Hostname of a quick-link site from its `anime` template (for crosswalk lookup). */
function siteHost(animeTemplate?: string): string | undefined {
  if (!animeTemplate) return undefined;
  try {
    return new URL(animeTemplate).hostname;
  } catch {
    return undefined;
  }
}

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
    stampBuild();

    const sites = (await quickLinks.getValue()).filter((s) => s.enabled && s.tracker === "anilist");
    if (sites.length === 0) return; // nothing to show

    // Crosswalk: real per-site slugs learned from past watches. Refreshed per page
    // (in sync) since a recent watch may have just captured the one we need.
    let crosswalk = await quickLinkSlugs.getValue();

    const getItems = (): QuickLinkItem[] => {
      const media = parseAniListPage();
      if (!media) return [];
      const items: QuickLinkItem[] = [];
      for (const s of sites) {
        const host = siteHost(s.anime);
        const canonical =
          host && media.anilistId !== undefined
            ? crosswalk[`${host}:${media.anilistId}`]
            : undefined;
        const links = buildAniListSiteLinks(s, media, canonical);
        if (links.direct || links.search) items.push({ name: s.name, ...links });
      }
      return items;
    };

    const animeId = () => location.pathname.match(/\/anime\/(\d+)/)?.[1] ?? null;

    // One quick-links UI at a time; re-created per anime page so its links match
    // the page. `gen` discards a mount whose navigation was superseded mid-await.
    let ui: Awaited<ReturnType<typeof mountQuickLinks>> | undefined;
    let gen = 0;
    // Titles of the anime we last mounted for, so a client-side nav can tell "the
    // sidebar still shows the PREVIOUS anime" apart from "this anime has rendered".
    let shownTitles: string | null = null;
    const sync = async () => {
      const my = ++gen;
      ui?.remove();
      ui = undefined;
      if (animeId() === null) return; // not an anime page
      crosswalk = await quickLinkSlugs.getValue(); // pick up slugs learned since last page

      // Show the block right away, but as placeholder chips until this anime's own
      // titles are on the page. The id is live in the URL immediately while the
      // sidebar still holds the PREVIOUS anime, so painting the links at that point
      // shows the id-only ones and then rearranges the block a beat later. `stale`
      // is what the sidebar said for the anime we last mounted for, which is how we
      // tell "not rendered yet" from "rendered". Bounded, so a page that never
      // produces a title still ends up showing whatever links we could build.
      const stale = shownTitles;
      const deadline = Date.now() + 3000;
      const loading = () => {
        const now = sidebarTitles();
        return (now === "" || now === stale) && Date.now() < deadline;
      };

      const created = await mountQuickLinks(ctx, getItems, {
        loading,
        // Top of the left info column (above the rankings), so it's visible without
        // scrolling to the "External & Streaming links" block near the bottom. mb-4
        // keeps it off the rankings element below.
        anchor: ".sidebar",
        append: "first",
        class: "mb-4",
      });
      if (my !== gen) return created.remove(); // navigated again while mounting
      ui = created;

      // Keep the panel in sync with a page that is still assembling itself.
      //
      // Two things outlive the first paint on client-side navigation:
      //  1. The links themselves. `loading` above holds the placeholder until the
      //     sidebar rows land; this is what swaps them for the real links, and what
      //     picks up any later re-render of those rows.
      //  2. Our host element. When AniList's render lands it can discard the node we
      //     injected, and WXT's `autoMount` only watches the ANCHOR (`.sidebar`),
      //     which survives, so nothing re-mounts us.
      //
      // So: re-mount when the host is gone, and re-paint whenever the computed links
      // change. Both checks are a handful of DOM reads, cheap enough to keep running
      // for the life of the page (an AniList tab stays open for a long time, and the
      // sidebar can re-render at any point).
      const paintKey = () => (loading() ? "loading" : `links:${fingerprint(getItems())}`);
      let last = paintKey();
      const timer = ctx.setInterval(() => {
        if (my !== gen) return clearInterval(timer); // superseded by a newer nav
        if (!created.attached()) created.mount();
        // Once the page has rendered, remember its titles: that's what the NEXT
        // navigation compares against to know the sidebar hasn't turned over yet.
        if (!loading()) shownTitles = sidebarTitles() || shownTitles;
        const now = paintKey();
        if (now === last) return;
        last = now;
        created.update();
      }, 200);
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

/**
 * The titles as they appear in AniList's OWN sidebar rows, empty until it renders
 * them. This is deliberately narrower than `parseAniListPage().title`, which falls
 * back to the page heading and `document.title`: those two are live almost
 * immediately on a client-side navigation, while `{romaji}` (which most site search
 * templates use) comes only from these rows. Treating a heading-derived title as
 * "ready" is what made the panel paint its id-only links first and then rearrange.
 *
 * Doubles as the "has the sidebar caught up with the URL?" signal: the anime id
 * changes before Vue swaps these rows, so during that window they still describe
 * the previous anime.
 */
function sidebarTitles(): string {
  const data = readDataSets();
  const english = data.English ?? "";
  const romaji = data.Romaji ?? "";
  return english === "" && romaji === "" ? "" : `${english}|${romaji}`;
}

/** Stable string form of the built links, so we only re-paint on a real change. */
function fingerprint(items: QuickLinkItem[]): string {
  return items.map((i) => `${i.name}|${i.direct ?? ""}|${i.search ?? ""}`).join("\n");
}

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
