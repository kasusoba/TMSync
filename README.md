<div align="center">
  <img src="packages/extension/public/icon/128.png" width="96" height="96" alt="TMSync icon">
  <h1>TMSync</h1>
  <p>
    <a href="https://chromewebstore.google.com/detail/tmsync/hkfpacmhbiccimikfleemmhfemdnjfpf"><b>Install for Chrome</b></a>
    &nbsp;·&nbsp;
    <a href="https://addons.mozilla.org/en-US/firefox/addon/tmsync/"><b>Install for Firefox</b></a>
  </p>
</div>

Automatically scrobble what you watch to your media trackers, on any streaming site. TMSync is
multi-tracker by design. Today it supports [Trakt](https://trakt.tv) and
[AniList](https://anilist.co), with room for more.

TMSync is a browser extension for Chrome and Firefox. While you watch on a streaming site it
reads what's playing, finds it on the right tracker, and logs it for you. No manual check-ins.
It also works on aggregator sites that don't have an official app or API, which most trackers
can't touch.

Each thing you watch is routed to the tracker that fits it. Right now that means movies and
live-action TV go to Trakt, and anime goes to AniList (anime can go to both at once). If you
know MAL-Sync for anime, this is the same idea, made general across trackers.

## What it does

- Detects the title and episode when you press play and records it to the right tracker, so your
  profile shows what you're currently watching and marks it watched when you finish. Movies and
  live-action TV go to Trakt in real time; anime goes to AniList (and can go to both).
- Works on most sites with a video and a readable title, including ones with no API.
- Lets you add a new site yourself with a point-and-click picker, like an ad blocker's element
  picker. No code.
- Got the wrong match? Click the badge, search the tracker, pick the right one. It remembers the fix.
- Rate what you watch and keep a private note per item, synced back to your tracker.
- Adds "watch on…" links to trakt.tv and anilist.co pages that take you to your usual streaming
  sites at the right episode.
- Your watch history only goes to your own tracker accounts. Matching and scrobbling happen on
  your machine, and each item goes only to the tracker it's routed to.
- Only gets access to a site once you enable it there. No broad permissions at install.

## Getting started

1. Install it from the
   [Chrome Web Store](https://chromewebstore.google.com/detail/tmsync/hkfpacmhbiccimikfleemmhfemdnjfpf)
   or [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tmsync/).
2. Click the toolbar icon and connect your Trakt account, your AniList account, or both.
3. Open something to watch on a supported site. A small badge shows what it matched. Press play.
4. On a new site, click "Set it up with the picker," point at the title and episode, and you're
   tracking it. You can share the result so others get the site too.

## Contributing

Site definitions ("recipes") are crowdsourced. Anyone can add support for a new site with a pull
request, no server involved. Code contributions are welcome too. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Support & status

This is a hobby project, maintained in spare time on a best-effort basis, with no SLA and no
guarantees. Issues and PRs are read and appreciated, but may be answered slowly. If something's
broken or a site stopped matching, opening an issue with the details is the most useful thing you
can do.

<!--
  Chrome Web Store listing copy, kept here so it stays in sync.

  Short description (max 132 chars):
  Auto-scrobble what you watch to your trackers (Trakt and AniList so far). Works on most streaming sites, no manual logging.

  Full description: the "What it does" + "Getting started" sections above.
-->

## For developers

Cross-browser WebExtension that passively scrobbles what you watch to the right tracker (movies
and live-action TV to Trakt, anime to AniList) using declarative **recipes** (data, not code).
Trackers sit behind a pluggable adapter seam, so the long-term vision is more trackers (for
example Simkl or MyAnimeList) added behind the same seam, never special-cased in the shared engine.

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md): **how the code works**, subsystem by subsystem (start here).
- [`docs/TMSync-PRD.md`](./docs/TMSync-PRD.md): the what/why (product).
- [`CLAUDE.md`](./CLAUDE.md): the settled architecture rules and hard constraints.
- [`docs/MULTI-TRACK.md`](./docs/MULTI-TRACK.md): the anime multi-tracking design.

### Monorepo layout

```
packages/shared      # recipe schema (Zod) + types + pure extraction engine (no DOM/browser globals)
packages/extension   # WXT app: entrypoints (background, content, options), engine, tracker adapters, picker, UI
recipes/index.json   # one tracker-agnostic recipe + quick-link library; each recipe carries its own
                     #   `tracker` (trakt | anilist); the engine routes per-recipe (PR-contributed)
```

**Adding a site or quick link?** See [`CONTRIBUTING.md`](./CONTRIBUTING.md); the recipe library is
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

What works today:
- **Foundation + engine**: monorepo, `@tmsync/shared` schema + pure `extract()`/`matchRecipe`,
  recipe-snapshot tests. MV3 posture with no broad host access at install (constraint #5).
- **Trakt**: OAuth (`launchWebAuthFlow`) + token refresh, search-based resolution with caching,
  real-time `/scrobble start|pause|stop` driven by a content-side state machine (debounce, one
  start per session, stop on ended/leave).
- **AniList + anime**: OAuth (authorization-code), GraphQL `Media` resolution, and threshold-based
  `SaveMediaListEntry` writes behind the same adapter seam (read-before-write, never lowers
  progress, "Rewatching?" confirm on a completed season). Anime can be multi-tracked to **both**
  trackers via the bundled TMDB↔AniList crosswalk (`docs/MULTI-TRACK.md`).
- **Element picker**: uBlock-style point-and-click (`@medv/finder`) in a Shadow-DOM overlay with
  auto-detect + live extract preview; saves a custom recipe and enables the site.
- **Ratings & notes**: rate what you finish at the levels each tracker supports (Trakt does
  show/season/episode, AniList does the cour), auto-prompted after a write or from the badge, plus
  one private note per item. Existing scores are read back from the tracker.
- **Quick links**: on a trakt.tv or anilist.co page, injects deep "watch on ..." links to your
  sites at the right episode (movie, show S1E1, season S{n}E1, episode S{n}E{m}); managed per-site,
  reorderable, independent of recipes.
- **Recipe library**: recipes and quick links fetch from a versioned `index.json` (ETag-conditional,
  schema-validated, cached), merged custom > remote > bundled. Picker edits shadow a library recipe
  for the same site.
- **Options page**: manage enabled sites, quick links (toggle/reorder/edit), the fetched library,
  your custom recipes (grouped by host), and corrections.
- **Runtime glue**: a Shadow-DOM scrobble badge showing live state and the matched title,
  click-to-correct (search the tracker, fix a wrong match, remembered per scraped title), SPA
  navigation + late-metadata re-matching, same-page and cross-origin iframe players (one frame
  scrobbles per tab), background reconciliation (a stop if a tab dies), and re-registration on
  startup.

Running the extension locally (load unpacked, connect a tracker, test a scrobble) is covered in
[`CONTRIBUTING.md`](./CONTRIBUTING.md#running-the-extension-locally).

## License

[GPL-3.0](./LICENSE). You're free to use, study, modify, and share it; derivative works must stay
open under the same license. TMSync talks only to your own Trakt/AniList accounts and is not
affiliated with or endorsed by Trakt or AniList.
