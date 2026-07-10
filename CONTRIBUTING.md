# Contributing to TMSync

Two kinds of contribution are welcome: **site definitions** (the easy, high-value one) and
**code**.

The most useful thing most people can contribute is a **site definition** — a recipe (so TMSync
can scrobble a streaming site) and/or a quick link (so a "watch on …" button appears on tracker
pages). Both live in one tracker-agnostic file, [`recipes/index.json`](./recipes/index.json) —
each recipe carries its own `tracker` field (`trakt` or `anilist`), so Trakt and anime sites
coexist in the same list — and are added by pull request. There is no backend and no account:
the library is just versioned JSON fetched from this repo.

> **Recipes are data, never code.** A recipe describes *where* a value is on the page and
> *how to clean it* — it can never run JavaScript. This is a hard requirement (MV3 + store
> policy), so the schema has no code escape hatch. If a site seems impossible to express
> declaratively, open an issue rather than trying to work around it.

**Code contributions** are welcome too — bug fixes, new tracker adapters, engine/UI improvements.
Because the architecture is deliberate, code PRs must respect the settled constraints in
[`CLAUDE.md`](./CLAUDE.md) and the design in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). The
big ones: recipes never carry executable code; the background stays stateless; no broad host
permissions at install; watch history only ever goes to the user's own tracker accounts; new
trackers go **behind the tracker-adapter seam**, never special-cased in the shared `extract()`
engine. **For anything non-trivial, open an issue first** so we can agree on the approach before
you invest time — see [Code contributions](#code-contributions) below.

> **Out of scope** (please don't PR these): sending watch history anywhere but the user's own
> tracker accounts, putting tracker-specific or anime-numbering logic into the shared engine, or a
> backend/hosted service (that's a deliberate future phase, not v1). Adding a *new tracker* behind
> the adapter seam is welcome in principle, but open an issue first. See [`CLAUDE.md`](./CLAUDE.md)
> for the full constraint list.

---

## `recipes/index.json` shape

```jsonc
{
  "recipes": [ /* scraping config — how to read media off a page */ ],
  "links":   [ /* quick links  — how to deep-link from Trakt out to a site */ ]
}
```

Entries you don't need can be omitted, but keep the two top-level keys. Every entry is
validated against the Zod schema in [`packages/shared/src/schema.ts`](./packages/shared/src/schema.ts)
on load — **an entry that fails validation is silently discarded**, so a typo means your
site just won't appear. Run the tests (below) before opening a PR; they validate the file.

---

## Recipes (scraping config)

The fastest way to author one is the **in-app element picker** — you don't have to hand-write
selectors:

1. `pnpm build`, load the extension, open the site on a movie/episode page.
2. Open the picker, point-and-click the title / year / season / episode (it auto-detects page
   metadata like `og:title` and JSON-LD first, and shows a live extract preview).
3. Save — it stores a working recipe locally.
4. Copy that recipe's JSON (Options → your custom recipes) into a new entry under `"recipes"`
   and open a PR.

### Recipe fields

```jsonc
{
  "id": "cineby-movie",          // unique, kebab-case, usually "<site>-<movie|tv|episode>"
  "schemaVersion": 3,            // must equal the current SCHEMA_VERSION (see packages/shared/src/schema.ts)
  "name": "Cineby",              // human-readable site name (shown in UI)
  "tracker": "trakt",            // "trakt" (movies/live-action TV) | "anilist" (anime). Routes the
                                 //   recipe at runtime; all recipes share one file. Omit → "trakt".
  "match": {
    "urlPattern": "www\\.cineby\\.at/movie",  // regex (escaped!) tested against location.href
    "hostnames": ["www.cineby.at"],           // hints only, not the primary match
    "domFingerprint": ".player"               // optional: a selector that must exist — clone-resilient
  },
  "mediaType": "auto",           // "auto" | "movie" | "show" ("auto" infers show when season/episode present)
  "video": {
    "selector": "video",         // the <video> element
    "frame": "auto",             // "auto" | "top" | "iframe" — where the player lives
    "watchedThreshold": 0.8      // per-site "finished here" point for long credits; NOT the watched decision
  },
  "extract": {
    "title":   { "source": "meta", "selector": "og:title", "transforms": ["trim", "collapseSpaces"] },
    "year":    { "source": "dom",  "selector": ".info .year", "transforms": ["trim", "toInt"] },
    "season":  { "source": "url",  "regex": "(?:\\D*\\d+){1}\\D*(\\d+)", "group": 1, "transforms": ["toInt"] },
    "episode": { "source": "url",  "regex": "(?:\\D*\\d+){2}\\D*(\\d+)", "group": 1, "transforms": ["toInt"] }
  }
}
```

A **`Field`** (each entry under `extract`) reads one value:

| key          | meaning |
|--------------|---------|
| `source`     | `url` · `title` (document title) · `meta` (a `<meta property/name>`) · `jsonld` (`<script type=ld+json>`) · `dom` (CSS selector) |
| `selector`   | for `dom`: a CSS selector · for `meta`: the property/name (e.g. `og:title`) · for `jsonld`: a dotted path (e.g. `partOfTVSeason.seasonNumber`) |
| `attr`       | `dom` only — read an attribute instead of `textContent` |
| `regex`      | applied to the raw string; capture a group |
| `group`      | capture-group index (default `1`) |
| `transforms` | ordered list: `trim` · `lowercase` · `uppercase` · `toInt` · `collapseSpaces` |

Only `title` is required. `year` helps movie disambiguation; `season` + `episode` make it a
show (with `mediaType: "auto"`).

**Authoring tips**
- Prefer stable sources in this order: `url` → `meta`/`jsonld` → `dom`. URLs and metadata rot
  far less than class names.
- Keep `urlPattern` specific enough to distinguish movie vs. TV/episode pages — usually a
  separate recipe per page type (see the cineby/popcornmovies pairs in the file).
- Remember `urlPattern` is a **regex string in JSON**: escape backslashes (`www\\.site\\.com`).

---

## Quick links (deep links from Trakt)

A quick link puts a "watch on \<site\>" button on a trakt.tv movie/show page. It's just URL
templates — independent of whether a recipe exists for that site.

```jsonc
{
  "id": "cineby",                                    // unique, kebab-case
  "name": "Cineby",                                  // shown on the button
  "movie": "https://www.cineby.at/movie/{tmdb}",
  "tv":    "https://www.cineby.at/tv/{tmdb}/{season}/{episode}",
  "search": "https://www.cineby.at/search?q={title}" // fallback when ids are missing
}
```

Placeholders, substituted from the Trakt page (never executed):

| placeholder         | value |
|---------------------|-------|
| `{tmdb}` `{imdb}`   | ids read from Trakt's own external links |
| `{title}`           | URL-encoded title |
| `{slug}`            | lowercase, hyphen-joined title (Trakt's URL slug, trailing year stripped) |
| `{slugyear}`        | the raw Trakt slug, year included |
| `{season}` `{episode}` | for `tv` — show → S1E1, season → S{n}E1, episode → S{n}E{m} |

If a `movie`/`tv` template references an id the page doesn't expose, TMSync falls back to
`search`. Library quick links arrive **disabled** — each user enables their favourites.

---

## Code contributions

Beyond recipes, PRs to the extension itself are welcome — bug fixes, a new tracker adapter, engine
or UI improvements. A few things that make a code PR easy to accept:

- **Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) first** — it's the map of how the pieces
  fit together and where each concern lives.
- **Respect the hard constraints in [`CLAUDE.md`](./CLAUDE.md).** They're settled decisions, not
  preferences. The load-bearing ones: recipes are data (no `eval`/remote code); the background
  service worker holds no session state; no broad host permissions at install; watch history goes
  only to the user's own tracker accounts; anything tracker-specific (including anime episode
  mapping) lives behind the tracker-adapter seam, never in the shared engine.
- **Adding a tracker?** That's the intended way to grow TMSync — a new `lib/<tracker>/` adapter + a
  picker toggle, without touching the other trackers or `extract()`. It's non-trivial, so **open an
  issue to align on the approach before you build.**
- **Open an issue before anything non-trivial.** For a typo or a small, obvious fix, just send the
  PR. For anything that changes behaviour or architecture, an issue first saves us both from a PR
  that has to be reworked.
- **Keep it green.** `pnpm typecheck`, `pnpm test`, and `pnpm lint` must all pass. Match the
  surrounding code style (Biome enforces formatting).

This is a spare-time project — reviews are best-effort and may take a while. That's not a lack of
interest; thanks for your patience.

---

## Before you open a PR

```bash
pnpm install
pnpm test        # validates recipes/index.json against the schema + runs the snapshot tests
pnpm typecheck   # required for code changes
pnpm lint
```

Then:
1. Edit `recipes/index.json` — add your recipe and/or quick link.
2. Confirm the schema test passes (a discarded entry = a schema mismatch to fix).
3. Open a PR describing the site and what you tested (movie page, episode page, scrobble fired).

Shipping a recipe in this repo makes its selectors **public** — that's the intended,
crowdsourced model. Don't include anything you wouldn't want public, and never commit Trakt or
AniList OAuth credentials or signing keys (`.env`, `.keys/*.pem` are git-ignored for this reason).
