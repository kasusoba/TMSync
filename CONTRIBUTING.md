# Contributing to TMSync

The most useful thing you can contribute is a **site definition** — a recipe (so TMSync
can scrobble a streaming site) and/or a quick link (so a "watch on …" button appears on
Trakt pages). Both live in one file, [`recipes/index.json`](./recipes/index.json), and are
added by pull request. There is no backend and no account: the library is just a versioned
JSON file fetched from this repo.

> **Recipes are data, never code.** A recipe describes *where* a value is on the page and
> *how to clean it* — it can never run JavaScript. This is a hard requirement (MV3 + store
> policy), so the schema has no code escape hatch. If a site seems impossible to express
> declaratively, open an issue rather than trying to work around it.

> **Out of scope** (please don't PR these): non-Trakt trackers (Simkl, Letterboxd, …),
> anime sites or absolute-episode-numbering logic, and anything that sends watch history
> anywhere but the user's own Trakt account. See [`CLAUDE.md`](./CLAUDE.md) for the full
> constraint list.

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
  "schemaVersion": 1,            // must equal the current SCHEMA_VERSION
  "name": "Cineby",              // human-readable site name (shown in UI)
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

## Before you open a PR

```bash
pnpm install
pnpm test        # validates recipes/index.json against the schema + runs the snapshot tests
pnpm lint
```

Then:
1. Edit `recipes/index.json` — add your recipe and/or quick link.
2. Confirm the schema test passes (a discarded entry = a schema mismatch to fix).
3. Open a PR describing the site and what you tested (movie page, episode page, scrobble fired).

Shipping a recipe in this repo makes its selectors **public** — that's the intended,
crowdsourced model. Don't include anything you wouldn't want public, and never commit Trakt
OAuth credentials or signing keys (`.env`, `.keys/*.pem` are git-ignored for this reason).
