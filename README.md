# TMSync

Track the movies and TV shows you watch to your [Trakt](https://trakt.tv) profile, automatically.

TMSync is a browser extension for Chrome and Firefox. While you watch on a streaming site it
reads what's playing, finds it on Trakt, and logs it for you. No manual check-ins. It also works
on aggregator sites that don't have an official app or API, which most trackers can't touch.

If you know MAL-Sync for anime, this is the same idea for movies and live-action TV on Trakt.

## What it does

- Detects the title and episode when you press play and scrobbles it to Trakt in real time, so
  your profile shows what you're currently watching and marks it watched when you finish.
- Works on most sites with a video and a readable title, including ones with no API.
- Lets you add a new site yourself with a point-and-click picker, like an ad blocker's element
  picker. No code.
- Got the wrong match? Click the badge, search Trakt, pick the right one. It remembers the fix.
- Rate movies, shows, seasons, and episodes, and keep a private note per item, all synced with Trakt.
- Adds "watch on…" links to trakt.tv pages that take you to your usual streaming sites at the
  right episode.
- Your watch history only goes to your own Trakt account. Matching and scrobbling happen on your
  machine.
- Only gets access to a site once you enable it there. No broad permissions at install.

## Getting started

1. Install it from the Chrome Web Store or Firefox Add-ons.
2. Click the toolbar icon and connect your Trakt account.
3. Open something to watch on a supported site. A small badge shows what it matched. Press play.
4. On a new site, click "Set it up with the picker," point at the title and episode, and you're
   tracking it. You can share the result so others get the site too.

## Contributing

Site definitions ("recipes") are crowdsourced. Anyone can add support for a new site with a pull
request, no server involved. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

<!--
  Chrome Web Store listing copy, kept here so it stays in sync.

  Short description (max 132 chars):
  Track the movies and TV you watch to your Trakt profile, automatically. Works on most streaming sites, no manual logging.

  Full description: the "What it does" + "Getting started" sections above.
-->

## For developers

Cross-browser WebExtension that passively scrobbles **movies & TV shows to Trakt** using
declarative **recipes** (data, not code). See [`TMSync-PRD.md`](./TMSync-PRD.md) for the
what/why and [`CLAUDE.md`](./CLAUDE.md) for the settled architecture and constraints.

### Monorepo layout

```
packages/shared      # recipe schema (Zod) + types + pure extraction engine (no DOM/browser globals)
packages/extension   # WXT app: entrypoints (background, content, options), engine, picker, UI
recipes/             # versioned index.json: recipes + quick links (Phase 1 source of truth, PR-contributed)
```

**Adding a site or quick link?** See [`CONTRIBUTING.md`](./CONTRIBUTING.md) — the recipe library is
crowdsourced via PRs to `recipes/index.json`.

### Develop

```bash
pnpm install            # also runs `wxt prepare`
pnpm dev                # Chrome dev (HMR)
pnpm dev:firefox        # Firefox dev
pnpm build              # build chrome-mv3 → packages/extension/.output
pnpm build:firefox      # build firefox-mv2

pnpm test               # vitest across packages
pnpm typecheck          # tsc --noEmit across packages
pnpm lint               # biome (format + lint)
pnpm format             # biome format --write
```

### Status

In place:
- **Foundation + engine** — monorepo, `@tmsync/shared` schema + pure `extract()`/`matchRecipe`,
  recipe-snapshot tests. MV3 posture: no broad host access at install (constraint #5).
- **Trakt + scrobbling** — OAuth (`launchWebAuthFlow`) + token refresh, search-based resolution
  with caching, real-time `/scrobble start|pause|stop`, and a content-side state machine
  (debounce, one start/session, stop on ended/leave).
- **Element picker** — uBlock-style point-and-click (`@medv/finder`) in a Shadow-DOM overlay with
  auto-detect + live extract preview; saves a custom recipe and enables the site.
- **Ratings & notes** — rate the movie/show/season/episode (auto-prompted after a history write or
  from the badge), keep one personal note per item, and sync existing ratings back from Trakt.
- **Quick links** — on a trakt.tv movie/show page, injects deep "watch on …" links to your favourite
  sites (movie → movie, show → S1E1, season → S{n}E1, episode → S{n}E{m}); managed per-site,
  reorderable, independent of recipes.
- **Recipe library** — recipes **and** quick links are fetched from a versioned `index.json`
  (ETag-conditional, schema-validated, cached), merged custom > remote > bundled. Local edits made
  with the picker shadow a library recipe for the same site.
- **Options page** — manage enabled sites, quick links (toggle/reorder/edit), the fetched library,
  your custom recipes (grouped by host), and corrections.

Also handled: a Shadow-DOM **scrobble badge** showing the live state **and what Trakt matched**,
**click-to-correct** (search Trakt and fix a wrong match, remembered per scraped title),
**SPA navigation** + late metadata (re-matches when the route/episode/og:title changes),
same-page **and** cross-origin **iframe players** (only one frame scrobbles per tab), background
**reconciliation** (a stop if a tab dies), and **re-registration on startup** (a plain extension
reload re-enables your sites).

First-run (Chrome):
1. `pnpm build` → load `.output/chrome-mv3` unpacked. The extension ID is stable
   (`aplaigellojlejhdjkklgihlmbmdaebk`). **After later `pnpm build`s, just hit the reload ↻ on the
   extension card — no need to remove/re-add; enabled sites re-register automatically.**
2. In your Trakt app (trakt.tv/oauth/applications) set the Redirect URI to
   `https://aplaigellojlejhdjkklgihlmbmdaebk.chromiumapp.org/`.
3. Popup → **Connect Trakt**.
4. On a media page → **Enable** the site (and any player-frame origin the popup lists), or **Set it
   up with the picker** for a new site. Reload, press play.
5. The badge shows live state + the matched title. Wrong match? Click the badge → search → pick.

Site definitions ship in [`recipes/index.json`](./recipes/index.json) and are fetched/refreshed at
runtime; add your own with the picker or contribute one via PR (see
[`CONTRIBUTING.md`](./CONTRIBUTING.md)).
