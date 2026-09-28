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

Entries you don't need can be omitted, but keep both top-level keys. The library may be empty
or small at any given time, so don't rely on existing entries as templates. The examples below
are enough to start.

Every entry is validated against the Zod schema in
[`packages/shared/src/schema.ts`](./packages/shared/src/schema.ts) on load. **An entry that fails
validation is silently discarded**, so a typo means your site just won't appear. The tests
validate the file, so run them before opening a PR.

You can also copy a recipe you made with the picker into `"recipes"`: in Options, open **Sites**
and use the copy icon on the recipe.

### Recipe fields

```jsonc
{
  "id": "cineby-movie",          // unique, kebab-case, usually "<site>-<movie|tv|episode>"
  "schemaVersion": 4,            // see "Schema version" below (4 because it names simkl)
  "name": "Cineby",              // human-readable site name (shown in UI)
  "trackers": ["trakt", "simkl"], // which trackers record this site: trakt | anilist | mal | simkl.
                                 //   Omit it and the legacy single `tracker` field (default
                                 //   "trakt") is used. Prefer `trackers` in new recipes.
  "match": {
    "urlPattern": "/movie",        // regex tested against location.href: the PATH, no host
    "hostnames": ["cineby.at"],    // the site's domain(s). A site that moves keeps its recipe
                                   //   and gains a hostname. Omit it and the recipe matches any host.
    "domFingerprint": ".player"    // optional: a selector that must exist (clone-resilient)
  },
  "mediaType": "auto",           // "auto" | "movie" | "show" ("auto" infers show when season/episode present)
  "video": {
    "selector": "video",         // the <video> element
    "frame": "auto",             // "auto" | "top" | "iframe": where the player lives
    "watchedThreshold": 0.8      // per-site "finished here" point for long credits (see below)
  },
  "extract": {
    "title":   { "source": "meta", "selector": "og:title", "transforms": ["trim", "collapseSpaces"] },
    "year":    { "source": "dom",  "selector": ".info .year", "transforms": ["trim", "toInt"] },
    "season":  { "source": "url",  "regex": "(?:\\D*\\d+){1}\\D*(\\d+)", "group": 1, "transforms": ["toInt"] },
    "episode": { "source": "url",  "regex": "(?:\\D*\\d+){2}\\D*(\\d+)", "group": 1, "transforms": ["toInt"] },
    "ids": {                     // optional: ids the page exposes, keyed by namespace
      "tmdb": { "source": "url", "regex": "/movie/(\\d+)", "group": 1, "transforms": ["toInt"] }
    }
  }
}
```

A **`Field`** (each entry under `extract`) reads one value:

| key          | meaning |
|--------------|---------|
| `source`     | `url` · `title` (document title) · `meta` (a `<meta property/name>`) · `jsonld` (`<script type=ld+json>`) · `dom` (CSS selector) |
| `selector`   | for `dom`: a CSS selector · for `meta`: the property/name (e.g. `og:title`) · for `jsonld`: a dotted path (e.g. `partOfTVSeason.seasonNumber`) |
| `attr`       | `dom` only: read an attribute instead of `textContent` |
| `regex`      | applied to the raw string; capture a group |
| `group`      | capture-group index (default `1`) |
| `transforms` | ordered list: `trim` · `lowercase` · `uppercase` · `toInt` · `collapseSpaces` · `deslugify` (turns `breaking-bad` into `breaking bad`) |

An `extract` needs **a `title` or at least one id**. `year` helps movie disambiguation. `season`
and `episode` make it a show (with `mediaType: "auto"`).

**`ids`** is a map from id namespace (`tmdb`, `imdb`, `tvdb`, `anilist`, `mal`) to a `Field`. When
a page exposes an id, usually in the URL, TMSync resolves by it instead of searching by title,
which avoids remake and same-title mix-ups. The title then becomes a display fallback. A
recipe can list several ids and each tracker uses the strongest one it understands. See
[`docs/IDENTITY-NAMESPACES.md`](./docs/IDENTITY-NAMESPACES.md).

**Other recipe fields**
- `canonical`: a `Field` that reads the site's own stable series slug. TMSync remembers it per
  anime, so the site's anime quick link can hit the exact page instead of a guessed title slug.
- `manualKey` and a missing `extract`: a **manual recipe**, for sites with no readable title
  (local-file players, watch-party rooms). The user picks the title from the badge, and
  `manualKey` is a field whose value tells one video from the next so the pick is remembered.

**Schema version.** `schemaVersion` must not exceed the current `SCHEMA_VERSION` in
`packages/shared/src/schema.ts` (today `4`). Builds ignore recipes newer than they understand.
Use `4` if the recipe names `mal` or `simkl`, and `3` otherwise, so it still reaches older
builds. The tests check this.

**`watchedThreshold`** is the point where TMSync treats the episode as finished, for sites with
long credits. For Trakt and Simkl it only decides *when* the stop is sent, because the tracker
owns the watched decision (80%). For AniList and MyAnimeList there is no scrobble API, so
crossing the threshold *is* the watched decision: it writes the list entry.

**Authoring tips**
- Prefer stable sources in this order: `url`, then `meta` or `jsonld`, then `dom`. URLs and
  metadata rot far less than class names.
- Keep `urlPattern` specific enough to tell movie pages from TV or episode pages. Usually that
  means one recipe per page type.
- Keep the domain out of `urlPattern` and in `hostnames`. Streaming sites move domain often,
  and the recipe then survives the move: add the new domain to `hostnames` and nothing else
  changes. Older recipes that carry the host in the pattern still work.
- Remember `urlPattern` is a **regex string in JSON**: escape backslashes (`/tv\\-shows`).
- **Anime sites:** an `anilist` or `mal` recipe assumes the site numbers episodes per season, as
  dedicated anime sites do. A site that uses absolute numbering (episode 50 of a 12-episode
  season) is refused with a warning instead of being written.

### Quick links

A quick link puts a "watch on \<site\>" button on a trakt.tv or anilist.co page. It is URL
templates, independent of whether a recipe exists for that site.

```jsonc
{
  "id": "cineby",                            // unique, kebab-case
  "name": "Cineby",                          // shown on the button
  "host": "cineby.at",                       // the site's domain, the one field to change if it moves
  "tracker": "trakt",                        // which tracker's pages it shows on: "trakt" | "anilist"
  "movie": "/movie/{tmdb}",
  "tv":    "/tv/{tmdb}/{season}/{episode}",
  "search": "/search?q={title}"              // fallback when ids are missing
}
```

A link for `"tracker": "anilist"` uses `anime` in place of `movie` and `tv`, for example
`"anime": "/watch/{slug}"`.

Placeholders, substituted from the tracker page (never executed):

| placeholder         | on | value |
|---------------------|----|-------|
| `{tmdb}` `{imdb}`   | Trakt | ids read from Trakt's own external links |
| `{title}`           | both | URL-encoded title (English or romaji on AniList) |
| `{slug}`            | both | lowercase, hyphen-joined title (on Trakt: the Trakt slug with a trailing year stripped) |
| `{slugyear}`        | Trakt | the raw Trakt slug, year included |
| `{season}` `{episode}` | Trakt `tv` | show gives S1E1, season gives S{n}E1, episode gives S{n}E{m} |
| `{anilist}`         | AniList | the AniList id |
| `{romaji}`          | AniList | URL-encoded romaji title |
| `{canonical}`       | AniList | the site's real slug, learned from a prior watch (needs a `canonical` field on the recipe) |

If a template references an id the page doesn't expose, TMSync falls back to `search`. Library
quick links arrive **disabled**, and each user enables their favourites.

---

## Code contributions

PRs to the extension itself are welcome: bug fixes, a new tracker adapter, engine or UI
improvements. A few things make a code PR easy to accept:

- **Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) first.** It is the map of how the
  pieces fit together and where each concern lives. [`docs/TMSync-PRD.md`](./docs/TMSync-PRD.md)
  covers the what and why, and [`docs/MULTI-TRACK.md`](./docs/MULTI-TRACK.md) covers the anime
  multi-tracking design.
- **Respect the hard constraints in [`CLAUDE.md`](./CLAUDE.md).** They are settled decisions,
  not preferences. The load-bearing ones:
  - Recipes are data (no `eval`, no remote code).
  - The background service worker holds no session state.
  - No broad host permissions at install.
  - Watch history goes only to the user's own tracker accounts.
  - Anything tracker-specific, including anime episode mapping, lives behind the tracker-adapter
    seam, never in the shared `extract()` engine.
- **Adding a tracker?** That is the intended way to grow TMSync: a new `lib/<tracker>/` adapter
  and a picker toggle, without touching the other trackers or `extract()`.
  [`docs/TRACKERS-PLAN.md`](./docs/TRACKERS-PLAN.md) shows how MyAnimeList and Simkl were added.
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
