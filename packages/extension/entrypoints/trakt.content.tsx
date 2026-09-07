import { stampBuild } from "@/lib/diagnostics/build-stamp";
import { quickLinks } from "@/lib/storage";
import { type QuickLinkItem, mountQuickLinks } from "@/lib/ui/quicklinks";
import { sendMessage } from "@/messaging";
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
    stampBuild();

    // Only Trakt-tracker quick links inject on Trakt pages (AniList ones show on
    // anilist.co — see anilist.content.tsx). Undefined tracker defaults to trakt.
    const sites = (await quickLinks.getValue()).filter(
      (s) => s.enabled && (s.tracker ?? "trakt") === "trakt",
    );
    if (sites.length === 0) return; // nothing to show

    const isApp = location.hostname.endsWith("app.trakt.tv");
    const parse = isApp ? parseAppTraktPage : parseTraktPage;

    // app.trakt.tv's DOM carries no TMDB id (see parseAppTraktPage) — resolve it
    // from Trakt's own API by slug instead. Cached per (type,slug) so repeat
    // paints of the same title don't re-hit the API; `pending` guards against
    // firing a second lookup for a still-in-flight slug. `live` is every
    // currently-mounted widget, so a resolved id repaints all of them at once.
    const tmdbCache = new Map<string, string | undefined>();
    const pending = new Set<string>();
    const live = new Set<Awaited<ReturnType<typeof mountQuickLinks>>>();
    const repaintAll = () => {
      for (const m of live) m.update();
    };

    // Readiness gate for a client-side navigation to ANOTHER title: the URL flips
    // before SvelteKit re-renders the summary, so for a moment the page still
    // shows the PREVIOUS title and IMDb id, and links built then would pair the
    // new slug with the old ids. `shownTitle` is what the header said for the page
    // we last painted, so "still the stale title" (or none yet) means not ready:
    // show placeholder chips until it turns over, bounded by a deadline so a page
    // that never renders a header still gets whatever links can be built.
    //
    // Armed on a PATH change only. A query-only navigation (opening a drawer,
    // stepping to the next episode) keeps the same header text, so gating on it
    // would freeze those drawers in the placeholder state for the whole deadline.
    let shownTitle: string | null = null;
    let staleTitle: string | null = null;
    let staleUntil = 0;
    const armStaleGate = () => {
      staleTitle = shownTitle;
      staleUntil = Date.now() + 3000;
    };
    const loading = () => {
      if (!isApp || Date.now() >= staleUntil) return false;
      const now = appHeaderTitle();
      return now === "" || now === staleTitle;
    };

    const getItems = (): QuickLinkItem[] => {
      const media = parse();
      if (!media) return [];
      if (isApp && media.slug && media.tmdb === undefined) {
        const apiType = media.type === "movie" ? "movie" : "show"; // TraktPageMedia uses "tv"
        const key = `${apiType}:${media.slug}`;
        if (tmdbCache.has(key)) {
          media.tmdb = tmdbCache.get(key);
        } else if (!pending.has(key)) {
          pending.add(key);
          void sendMessage("traktIdsForSlug", { type: apiType, slug: media.slug })
            .then((ids) => {
              tmdbCache.set(key, ids?.tmdb !== undefined ? String(ids.tmdb) : undefined);
            })
            .catch(() => {
              // leave uncached so a later paint (e.g. after nav) retries
            })
            .finally(() => {
              pending.delete(key);
              repaintAll();
            });
        }
      }
      const items: QuickLinkItem[] = [];
      for (const s of sites) {
        const links = buildSiteLinks(s, media);
        if (links.direct || links.search) items.push({ name: s.name, ...links });
      }
      return items;
    };

    /** Stable string form of what a paint would show, so we repaint only on a real change. */
    const paintKey = () =>
      loading()
        ? "loading"
        : getItems()
            .map((i) => `${i.name}|${i.direct ?? ""}|${i.search ?? ""}`)
            .join("\n");

    if (!isApp) {
      await mountQuickLinks(ctx, getItems, { anchor: "ul.external", append: "after" });
      return;
    }

    // The show/movie page's own "Where to Watch" section. autoMount brings the
    // block up as soon as that section renders; keeping it up across client-side
    // navigation is the watchdog's job (see the poll at the end of main()).
    const mainUi = await mountQuickLinks(ctx, getItems, {
      anchor: whereToWatchAnchor,
      append: "after",
      label: null,
      class: "my-3",
      loading,
    });
    live.add(mainUi);

    // The season-browsing drawer (`?view=seasons`) and the per-episode drawer
    // (`?view=episode`) are a different story: Svelte tears down and rebuilds
    // each one's subtree on every open/close, and can flip DIRECTLY between the
    // two kinds without a plain "closed" state in between. We track which one
    // is relevant via the `view` query param and (re)mount fresh whenever it
    // changes kind. This CANNOT go through WXT's `autoMount` (mountQuickLinks's
    // default): its one-time up-front check throws "autoMount and Element
    // anchor option cannot be combined" the instant the anchor function already
    // resolves to a real Element — which it reliably does here, since we only
    // call this once we've already confirmed (via `view`) the drawer is open.
    // So this uses `auto: false` (a plain one-shot mount — see quicklinks.tsx)
    // and drives mount/unmount entirely ourselves off the `view` param instead.
    let drawerUi: Awaited<ReturnType<typeof mountQuickLinks>> | undefined;
    let drawerKind: "episode" | "seasons" | null = null;
    let drawerBusy = false;
    const drawerAnchor = (kind: "episode" | "seasons" | null) =>
      kind === "episode" ? episodeDrawerAnchor : kind === "seasons" ? seasonsDrawerAnchor : null;
    const syncDrawer = async () => {
      const view = new URLSearchParams(location.search).get("view");
      const kind = view === "episode" ? "episode" : view === "seasons" ? "seasons" : null;
      if (kind === drawerKind || drawerBusy) return;
      const anchor = drawerAnchor(kind);
      // `view` flips via pushState slightly BEFORE Svelte finishes rendering the
      // drawer's DOM — if the anchor isn't there yet, leave `drawerKind` as-is so
      // a later poll tick retries, instead of giving up on this drawer.
      if (anchor && !anchor()) return;
      drawerBusy = true;
      try {
        if (drawerUi) {
          drawerUi.remove();
          live.delete(drawerUi);
          drawerUi = undefined;
        }
        drawerKind = kind;
        if (!anchor) return;
        drawerUi = await mountQuickLinks(ctx, getItems, {
          anchor,
          append: "after",
          label: null,
          class: "my-3",
          auto: false,
          loading,
        });
        live.add(drawerUi);
      } finally {
        drawerBusy = false;
      }
    };
    await syncDrawer();

    // One watchdog for every kind of client-side navigation. It polls `location`
    // rather than listening for `wxt:locationchange`, mirroring
    // anilist.content.tsx (history patching in the page's world doesn't reliably
    // reach an isolated content script). Three things need it:
    //
    //  1. The DRAWERS: mount/unmount them, and re-read the media after a
    //     season/episode step WITHIN an open one (prev/next pushes a new
    //     `location.search` without changing `view`, which syncDrawer alone
    //     would not notice).
    //  2. REPAINT once late page data lands. Nothing about the new page is in
    //     the DOM at the instant the URL flips: the title and the IMDb id come
    //     with the render, the TMDB id from our own API call. Repainting when
    //     the built links change picks all of that up, and is also what ends
    //     the readiness gate above.
    //  3. RE-MOUNT a host the page discarded, as a safety net. autoMount only
    //     watches the ANCHOR, so a re-render that drops our node while keeping
    //     the anchor leaves nothing to bring it back (the same failure
    //     anilist.content.tsx guards against).
    let lastPath = location.pathname;
    let lastPaint = paintKey();
    ctx.setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        armStaleGate();
      }
      // Cheap no-op while the open drawer already matches `view`; retries by
      // itself on the tick after one whose DOM had not rendered yet.
      void syncDrawer();
      // A torn-down host: put it back as soon as its anchor is there again.
      if (!mainUi.attached() && whereToWatchAnchor()) mainUi.mount();
      if (drawerUi && !drawerUi.attached() && drawerAnchor(drawerKind)?.()) drawerUi.mount();
      if (!loading()) shownTitle = appHeaderTitle() || shownTitle;
      const now = paintKey();
      if (now === lastPaint) return;
      lastPaint = now;
      repaintAll();
    }, 250);
  },
});

/**
 * Resolve the "Where to Watch" section element on app.trakt.tv. Returns null
 * until the section is present, so autoMount WAITS for it rather than dropping
 * our row at the bottom of the column (below Sentiment).
 *
 * The list's own wrapper class (`.trakt-where-to-watch-list`) is what we match,
 * NOT the "Where to Watch" heading text. On a client-side navigation the wrapper
 * and its `<section>` are rebuilt straight away while the heading inside them
 * stays unrendered for a long time (often indefinitely, verified on app.trakt.tv
 * 2026-09), so a heading-text match found nothing and the block only ever
 * appeared after a full reload. The heading walk is kept as a fallback in case
 * the wrapper class is renamed.
 */
function whereToWatchAnchor(): Element | null {
  const root = document.querySelector(".trakt-summary-contextual-content");
  if (!root) return null;
  const list = root.querySelector(".trakt-where-to-watch-list");
  if (list) return list.querySelector("section") ?? list;
  for (const title of root.querySelectorAll(".shadow-list-title")) {
    if (title.textContent?.trim().toLowerCase() === "where to watch") {
      const section = title.closest("section");
      if (section) return section;
    }
  }
  return null;
}

/**
 * Resolve the anchor inside an OPEN episode drawer (`?view=episode`). The
 * drawer has no "Where to Watch" section of its own, so we place our links
 * right after the episode overview (description), before the Info/Reviews/
 * Episodes tabs — the same relative spot as the show-page placement above.
 * Returns null while no drawer is open.
 */
function episodeDrawerAnchor(): Element | null {
  return document.querySelector(".trakt-episode-drawer .episode-info-overview");
}

/**
 * Resolve the anchor inside an OPEN season-browsing drawer (`?view=seasons`,
 * opened via the "Seasons" expand button) — a THIRD, separate surface from
 * both the show page and the episode drawer, also with no "Where to Watch"
 * section of its own. Placed right after the season-poster carousel, before
 * the Episodes/Info/Reviews tabs (stable regardless of which tab is active).
 * Returns null while no such drawer is open.
 */
function seasonsDrawerAnchor(): Element | null {
  return document.querySelector(".seasons-drawer-content .seasons-section");
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
 * The title as app.trakt.tv's own summary header renders it, "" until it does.
 * Doubles as the "has the page caught up with the URL?" signal: on a client-side
 * navigation the URL is live while this still names the PREVIOUS title.
 */
function appHeaderTitle(): string {
  return document.querySelector('[data-testid="summary-media-title"]')?.textContent?.trim() ?? "";
}

/**
 * Map the current app.trakt.tv page to outbound media. The new app exposes the
 * slug (URL), the title, and an IMDB id (ratings link), plus season/episode from
 * the path/query — but no TMDB id anywhere in its DOM (the classic site's
 * `#external-link-tmdb` has no equivalent here), so the caller resolves `{tmdb}`
 * separately via the Trakt API (see main() above). Shapes: `/movies/{slug}`,
 * `/shows/{slug}` (+ `?season=N&episode=N`), `/shows/{slug}/seasons/{s}` and
 * `…/seasons/{s}/episodes/{e}`. The season page (`?season=N`, no `episode`) has
 * no single "current" episode, so it defaults to episode 1 — the episode-drawer/
 * episode-page query param (`?season=N&view=episode&episode=M`) is what actually
 * updates as the user steps through episodes, even though it's a client-side
 * drawer overlay rather than a full navigation.
 */
function parseAppTraktPage(): TraktPageMedia | null {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  const title =
    appHeaderTitle() || document.querySelector("main h1")?.textContent?.trim() || undefined;
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
  const episode = Number(params.get("episode")) || 1;
  return { type: "tv", slug, season, episode, ...ids, title };
}
