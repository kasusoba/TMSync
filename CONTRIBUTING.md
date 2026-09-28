# Contributing to TMSync

Two kinds of contribution are welcome: **site definitions** (the easy, high-value one) and
**code**. Chat about either on the [TMSync Discord](https://discord.gg/XCRsUnrJR).

- [Site definitions](#site-definitions): recipes and quick links
- [Code contributions](#code-contributions)
- [Running the extension locally](#running-the-extension-locally)
- [Before you open a PR](#before-you-open-a-pr)

---

## Site definitions

The most useful thing most people can contribute is a **recipe** (so TMSync can scrobble a
streaming site) and/or a **quick link** (so a "watch on ..." button appears on tracker pages).
Both live in one tracker-agnostic file, [`recipes/index.json`](./recipes/index.json). Each recipe
names the trackers it records to, so Trakt, Simkl, and anime sites coexist in the same list.
There is no backend: the library is versioned JSON fetched from this repo, and it reaches every
user with the next library sync after a PR merges.

> **Recipes are data, never code.** A recipe describes *where* a value is on the page and
> *how to clean it*. It can never run JavaScript. This is a hard requirement (MV3 + store
> policy), so the schema has no code escape hatch. If a site seems impossible to express
> declaratively, open an issue rather than trying to work around it.

### The easy way: contribute from the extension

1. Build the extension (see [Running the extension locally](#running-the-extension-locally))
   or use the store version. Open the site on a movie or episode page.
2. In the toolbar popup, click **Set up recipe**. Point at the title, year, season, and episode.
   The picker auto-detects page metadata (`og:title`, JSON-LD) first and shows a live preview of
   what it reads. Save it, then check that the badge matches the right title.
3. In the extension's options, open **Contribute**. Tick the recipes and quick links to share
   and click the button to open a prefilled GitHub issue. It carries site config only, never
   watch data. Submit the issue as it is.
4. A maintainer checks the issue and adds the `contribution` label. A bot then opens a pull
   request from it and comments on the issue with the link. After review and merge, your site
   is in the library.

If the JSON is too long to prefill, TMSync copies it and the issue asks you to paste it.

### The manual way: edit `recipes/index.json`

```jsonc
{
  "recipes": [ /* scraping config: how to read media off a page */ ],
  "links":   [ /* quick links: how to deep-link from a tracker page out to a site */ ]
}
```

Keep both top-level keys. The library may be empty or small at any given time, so don't rely on
existing entries as templates. [`docs/RECIPES.md`](./docs/RECIPES.md) has a full annotated recipe,
the field reference, authoring tips, and the quick-link placeholders. A minimal recipe looks like
this:

```jsonc
{
  "id": "cineby-movie",
  "schemaVersion": 3,
  "name": "Cineby",
  "trackers": ["trakt"],
  "match": { "urlPattern": "/movie", "hostnames": ["cineby.at"] },
  "mediaType": "movie",
  "extract": {
    "title": { "source": "meta", "selector": "og:title", "transforms": ["trim"] }
  }
}
```

Every entry is validated against the Zod schema in
[`packages/shared/src/schema.ts`](./packages/shared/src/schema.ts) on load. **An entry that fails
validation is silently discarded**, so a typo means your site just won't appear. The tests validate
the file, so run them before opening a PR. To copy a recipe you made with the picker, open Options,
then Sites, and use the copy icon on the recipe.

---

## Code contributions

PRs to the extension itself are welcome: bug fixes, a new tracker adapter, engine or UI
improvements. A few things make a code PR easy to accept:

- **Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) first.** It is the map of how the
  pieces fit together and where each concern lives, including how anime is tracked to several
  trackers at once.
- **Respect the hard constraints in [`CLAUDE.md`](./CLAUDE.md).** They are settled decisions,
  not preferences. The load-bearing ones:
  - Recipes are data (no `eval`, no remote code).
  - The background service worker holds no session state.
  - No broad host permissions at install.
  - Watch history goes only to the user's own tracker accounts.
  - Anything tracker-specific, including anime episode mapping, lives behind the tracker-adapter
    seam, never in the shared `extract()` engine.
- **Adding a tracker?** That is the intended way to grow TMSync: a new `lib/trackers/<tracker>/` adapter
  and a picker toggle, without touching the other trackers or `extract()`.
  [`docs/TRACKERS.md`](./docs/TRACKERS.md) has the API facts for each tracker and a checklist for
  adding one.
  It is non-trivial, so **open an issue to align on the approach before you build.**
- **Open an issue before anything non-trivial.** For a typo or a small, obvious fix, just send
  the PR. For anything that changes behaviour or architecture, an issue first saves us both from
  a PR that has to be reworked.
- **Keep it green.** `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm build` must all pass.
  Match the surrounding code style (Biome enforces formatting).
- **Match the UI kit.** UI changes reuse the tokens and primitives in
  `packages/extension/lib/ui/kit`. Add new states to the gallery page (`gallery.html` in a dev
  build), which renders every surface with mock data.

> **Out of scope** (please don't PR these): sending watch history anywhere but the user's own
> tracker accounts, putting tracker-specific or anime-numbering logic into the shared engine, or a
> backend or hosted service. See [`CLAUDE.md`](./CLAUDE.md) for the full constraint list.

This is a spare-time project. Reviews are best-effort and may take a while. That is not a lack of
interest; thanks for your patience.

### Repo layout

```
packages/shared      # recipe schema (Zod) + types + pure extraction engine (no DOM/browser globals)
packages/extension   # WXT app: entrypoints (background, content, popup, options), engine, tracker adapters, picker, UI
recipes/index.json   # the tracker-agnostic recipe + quick-link library (PR-contributed)
recipes/anime-map.json # the TMDB to AniList crosswalk (generated weekly by CI, do not edit by hand)
docs/                # design notes
scripts/             # release, contribution bot, and crosswalk build
```

### Branches, commits, and PRs

Work never lands on `main` directly. Fork the repo (maintainers can branch directly), then:

```bash
git checkout -b feat/short-slug     # type is feat, fix, docs, chore, or refactor
# ...commit...
git push -u origin feat/short-slug
gh pr create
```

- **Commits.** Write in short, plain sentences and say *why* in the body. Commits land on `main`
  as they are (the maintainer rebase-merges, never squashes), so each one must build and read
  well on its own. Fold fixups in before you push: `git commit --fixup <sha>`, then
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash main`.
- **PR title.** It becomes a line in the release notes, so write it for a user: what changed for
  them, in plain words, with no type prefix and no scope. The body carries the detail.
- **Style.** Do not use em dashes or en dashes in UI text, docs, comments, or commit messages.
  Use commas, periods, or parentheses.

---

## Running the extension locally

You need Node 22 or newer (see `.nvmrc`) and pnpm 10 (`corepack enable` picks the right one).

```bash
pnpm install            # also runs `wxt prepare` and installs the pre-push hook
pnpm build              # Chrome MV3 build to packages/extension/.output/chrome-mv3
pnpm build:firefox      # Firefox build to packages/extension/.output/firefox-mv2
pnpm dev                # Chrome dev build that rebuilds on change
pnpm dev:edge           # same, for Edge
pnpm dev:firefox        # Firefox dev
```

1. **Credentials.** Copy `packages/extension/.env.example` to `packages/extension/.env` and fill
   in the client ids for the trackers you want to test. The build works without it, but that
   build cannot sign in. Each tracker needs an app of your own:
   - **Trakt:** trakt.tv/oauth/applications (client id and secret).
   - **AniList:** anilist.co/settings/developer (client id and secret). AniList allows one
     redirect URL per app, so testing in Firefox needs a second app (`*_FIREFOX` vars).
   - **MyAnimeList:** myanimelist.net/apiconfig, app type "other" (client id only).
   - **Simkl:** simkl.com/settings/developer, "Mobile, desktop & browser apps" (client id only).
     The type cannot be changed later.

   Register the redirect URL for your browser on each app. In dev builds the options page shows
   the exact URL under each tracker's Account row.
   - Chrome: `https://hkfpacmhbiccimikfleemmhfemdnjfpf.chromiumapp.org/`
   - Firefox: `https://c157c991dd25293a3ddf036ad9bb628ad193a5ee.extensions.allizom.org/`
2. **Load it.** In Chrome or Edge, open `chrome://extensions`, turn on Developer mode, and
   "Load unpacked" the `.output/chrome-mv3` folder (or `.output/chrome-mv3-dev` for `pnpm dev`).
   In Firefox, open `about:debugging`, choose "This Firefox", and load a temporary add-on from
   the Firefox build's `manifest.json`.

   The Chrome extension ID is stable (`hkfpacmhbiccimikfleemmhfemdnjfpf`) and equals the Chrome
   Web Store ID, so in a profile that has the store TMSync, turn that one off first. After later
   builds, hit the reload icon on the extension card. No need to remove and re-add, and enabled
   sites re-register automatically.
3. **Connect.** Open the popup and connect a tracker.
4. **Allow a site.** On a media page, enable the site under **Video detection** in the popup (and
   any player-frame origin it lists), or click **Set up recipe** for a new site. Reload, then
   press play.
5. **Check.** The badge shows live state and the matched title. Wrong match? Click the badge,
   search, and pick.

Not sure whether the build you loaded is the one you just made? Every content script stamps its
build time on the page. In the page console:

```js
document.documentElement.dataset.tmsyncBuild
```

---

## Before you open a PR

```bash
pnpm test        # unit tests, including recipes/index.json against the schema
pnpm typecheck   # tsc --noEmit across packages
pnpm lint        # biome (format + lint); `pnpm format` fixes formatting
pnpm build       # and `pnpm build:firefox`
```

A pre-push git hook runs the same five checks CI does (typecheck, lint, test, build,
build:firefox), so a red push is caught locally. `pnpm test:e2e` runs the Playwright test from
`packages/extension` and is not part of CI.

For a **site definition** PR:
1. Edit `recipes/index.json` and add your recipe and/or quick link.
2. Confirm the tests pass (a discarded entry means a schema mismatch to fix).
3. Open a PR that names the site and says what you tested: movie page, episode page, and that a
   scrobble fired.

Shipping a recipe in this repo makes its selectors **public**. That is the intended, crowdsourced
model. Don't include anything you wouldn't want public, and never commit tracker OAuth
credentials or signing keys (`.env` and `.keys/` are git-ignored for this reason).

Maintainers: see [`docs/RELEASING.md`](./docs/RELEASING.md) for cutting a release.
