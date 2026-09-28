# Recipes

A recipe is declarative data that tells the engine where a title, year, season, and episode sit on
a streaming page and how to clean them. It is never code. This page is the reference for writing
one, how recipes are versioned, and how they reach users. To submit one, see
[`CONTRIBUTING.md`](../CONTRIBUTING.md). The Zod schema in
[`packages/shared/src/schema.ts`](../packages/shared/src/schema.ts) is the source of truth.

- [Anatomy of a recipe](#anatomy-of-a-recipe)
- [Fields and ids](#fields-and-ids)
- [One recipe or two](#one-recipe-or-two)
- [Quick links](#quick-links)
- [Versioning](#versioning)
- [Where recipes live](#where-recipes-live)
- [Maintenance: site rot and domain moves](#maintenance-site-rot-and-domain-moves)
- [Contribution mechanics](#contribution-mechanics)

---

## Anatomy of a recipe

```jsonc
{
  "id": "cineby-movie",          // unique, kebab-case, usually "<site>-<movie|tv|episode>"
  "schemaVersion": 4,            // see Versioning (4 here because it names simkl)
  "name": "Cineby",              // human-readable site name (shown in UI)
  "trackers": ["trakt", "simkl"], // trakt | anilist | mal | simkl. Omit it and the legacy single
                                 //   `tracker` field (default "trakt") is used. Prefer `trackers`.
  "match": {
    "urlPattern": "/movie",        // regex tested against location.href: the PATH, no host
    "hostnames": ["cineby.at"],    // the site's domain(s). Omit it and the recipe matches any host.
    "domFingerprint": ".player"    // optional: a selector that must exist (clone-resilient)
  },
  "mediaType": "auto",           // "auto" | "movie" | "show" ("auto" infers show when season/episode present)
  "video": {
    "selector": "video",         // the <video> element
    "frame": "auto"              // "auto" | "top" | "iframe": where the player lives
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

The easiest way to write one is the extension's picker (**Set up recipe** in the popup). It
auto-detects metadata first and shows a live preview of what the engine reads. Then copy the result
from Options, under Sites.

A recipe does not set when an episode counts as finished. The engine uses one fixed point, 80%
(`WATCHED_THRESHOLD` in `lib/tracker/types.ts`), which matches Trakt's own rule. For Trakt and Simkl it
decides *when* the stop is sent. For AniList and MyAnimeList it *is* the watched decision. Older
recipes may still carry `video.watchedThreshold`. The schema drops it, so it has no effect.

## Fields and ids

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

**Identity ids.** A page often exposes an id, usually in the URL. `extract.ids` maps an id
namespace to a `Field`: `tmdb`, `imdb`, `tvdb`, `anilist`, or `mal`. A page can expose several, and
resolution tries them best-first. With an id, a tracker looks the item up exactly, which avoids
remake and same-title mix-ups. The title then becomes a display fallback. `imdb` ids are strings
(`tt1375666`) and the rest are numeric.

A namespace is the site's *source identity* (which id catalog the page hands you). It is not the
destination. Miruro exposes a TMDB id but writes to AniList, because a recipe's destination is its
own `trackers` field. Each tracker adapter declares which namespaces it resolves natively
(`resolvableNamespaces`), and resolution runs a ladder: a native id, then an id mapped through the
anime crosswalk, then a title search, then the user-correction picker. See the tracker section of
[`ARCHITECTURE.md`](./ARCHITECTURE.md#5-tracker-adapters-the-seam-that-keeps-the-trackers-apart).

**Other fields**
- `canonical`: a `Field` that reads the site's own stable series slug. TMSync remembers it per
  anime, so the site's anime quick link can hit the exact page instead of a guessed title slug.
- `manualKey` and a missing `extract`: a **manual recipe**, for sites with no readable title
  (local-file players, watch-party rooms). The user picks the title from the badge, and `manualKey`
  is a field whose value tells one video from the next so the pick is remembered.

**Authoring tips**
- Prefer stable sources in this order: `url`, then `meta` or `jsonld`, then `dom`. URLs and
  metadata rot far less than class names.
- Keep `urlPattern` specific enough to tell movie pages from TV or episode pages. Usually that
  means one recipe per page type.
- Keep the domain out of `urlPattern` and in `hostnames`, so a site that moves keeps its recipe.
  Older recipes that carry the host in the pattern still work.
- `urlPattern` is a **regex string in JSON**: escape backslashes (`/tv\\-shows`).
- **Anime sites:** an `anilist` or `mal` recipe assumes the site numbers episodes per season, as
  dedicated anime sites do. A site that uses absolute numbering (episode 50 of a 12-episode season)
  is refused with a warning instead of being written.

Recipe ids are readable and stable, not timestamps. The picker derives one from the host slug
(`www.miruro.to` becomes `miruro-to`), with `-2`, `-3` on a collision (`lib/recipe-id.ts`). Two
users who contribute the same site then produce the same id, so the library never gets a silent
duplicate. No store references a recipe id as a foreign key, so ids can change freely.

## One recipe or two

Whether a site needs one recipe or two disjoint ones depends on whose numbering the site speaks
(native vs derived, in [`ARCHITECTURE.md`](./ARCHITECTURE.md)), not on how many media types it
hosts.

**A TMDB-native site with the type in the URL needs two recipes.** Aether has
`aether.bar/media/tmdb-tv-2604-...` and `aether.bar/media/tmdb-movie-1244492-...`. Movie and TV are
different TMDB id namespaces, and Trakt tells movies from shows, so these are two resolutions. A
naive `urlPattern` (`aether\.bar/media`) would match both, and the second recipe would shadow the
first. The picker keeps the typed-id prefix, so the two come out disjoint on their own:
`aether\.bar/media/tmdb-tv-` and `aether\.bar/media/tmdb-movie-`.

**An AniList-native slug site where a movie is "episode 1" needs one recipe.** You do not separate
movies from series, because AniList does not: a movie entry has `episodes: 1`, and writing progress
1 completes it, the same path as a series finale. The Trakt side, if it is on, gets the movie or
show split from the crosswalk (`animap.reverse` returns `tmdbKind: "movie" | "tv"`). Use
`mediaType: "auto"` and always scrape `episode`. Never use `mediaType: "movie"` here, because the
builder drops season and episode for movies and AniList would have nothing to write. The badge drops
the `E1` suffix on a single-episode entry. The remaining risk is a series and a movie that share a
title, which the correction system handles, not the recipe.

Rule of thumb: a TMDB-native site splits by `urlPattern`, and an AniList-native site is one recipe.

## Quick links

A quick link puts a "watch on \<site\>" button on a trakt.tv or anilist.co page. It is URL
templates, independent of whether a recipe exists for that site. Quick links are managed per site.

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

## Versioning

There are two version axes, and they never mix.

| | Where it lives | What it gates | When it changes |
|---|---|---|---|
| **`schemaVersion`** | on every recipe (`SCHEMA_VERSION`, currently `4`) | the *shape* of recipe data | only when a change would make an old client misread a recipe |
| **Extension version** | `packages/extension/package.json` | the app build | every release, and it never appears on a recipe |

A recipe is data shared across many extension builds, so it carries only its own `schemaVersion`.
The guard is in `selectRecipe` (`packages/shared/src/match.ts`): a client skips any recipe newer
than it understands, and reads older recipes through schema defaults.

Classify a schema change before making it:

- **Additive, and old clients degrade gracefully: no bump.** A new *optional* field that old
  clients ignore and that defaults sensibly. `tracker` (default `"trakt"`) and `trackers[]` (absent
  means `[tracker]`) shipped this way. Document the default next to the field.
- **Breaking for old clients: bump `SCHEMA_VERSION`.** Anything an old client would crash on or
  misread: a new `Transform` or `source` enum value, a new required field, a renamed field, or
  changed meaning. A new enum value feels additive but is not, because an old client's Zod parse
  rejects it.

Litmus test: would a client one version behind produce a wrong scrobble, and not just a skipped
one, if it read this recipe? If yes, bump. If it would only skip or safely default, it is additive.

Version 4 added the MyAnimeList and Simkl trackers. A recipe that names either carries
`schemaVersion: 4`, and one that names only Trakt and AniList stays at 3 so it still reaches older
builds (`minSchemaVersion`). A legacy `extract.tmdbId` folds into `ids.tmdb` through a schema
transform, so old recipes keep parsing.

When a real break is needed, do both halves together. Add a storage migration for the user's custom
recipes, which are the only data users own. Regenerate the library at the new `schemaVersion`, and
optionally keep both tiers live for a while so builds that have not updated keep working.

## Where recipes live

- **Custom recipes** are the user's own. They sync across the user's browsers through
  `browser.storage.sync`, one key per recipe (`recipe:{id}`), and never go to a TMSync server.
- **Library recipes** live in [`recipes/index.json`](../recipes/index.json), one tracker-agnostic
  list, and are contributed by pull request. The extension fetches the list from the repo CDN every
  12 hours (`alarms`, conditional on the ETag) and also bundles a copy as an offline seed.
- **Precedence:** the user's custom recipes win, then the fetched list, then the bundled seed. A
  local recipe shadows a library recipe for the same target (hosts plus pattern), even if the ids
  differ, so there is one effective recipe per target and never a double match.

Because the list comes over the CDN, fixing a rotted library recipe reaches every user on their
next refresh, with no extension release.

## Maintenance: site rot and domain moves

Schema changes are rare. The real ongoing cost is **site rot**: a site changes its DOM or URLs and a
recipe's selectors or `urlPattern` stop matching. The loop is:

1. **Detect.** A recipe-snapshot test goes red in CI (saved HTML plus the expected `extract()`
   output, in `packages/extension/test/fixtures/`), or a user hits a bad parse.
2. **Fix.** Re-pick with the picker and contribute the updated recipe.
3. **Ship.** Merge, and the CDN serves it on the next refresh.

A change to a picker heuristic such as `suggestUrlPattern` does not rot saved recipes. Heuristics
run only when a recipe is authored, and a saved recipe keeps its stored `match`.

**A site changes domain** is the most common rot of all. The pages are unchanged, so the recipe is
right and only the hostname is new. That is why the host lives in one place per artifact: a recipe
has `match.hostnames` (the host scope and the origins TMSync asks permission for), and a quick link
has `host`, with paths below it. `packages/shared/src/hosts.ts` reads and rewrites the host anchor
that older patterns carry. A move is handled in one of three ways, cheapest first:

1. **The popup offers it.** Open the popup on the new domain. If one of your sites has the same
   name on another domain, it asks "Did Cinejoy move here?". One click asks for access, adds the
   domain to every recipe of that site, and starts tracking (`findMovedSite` in
   `packages/extension/lib/sites.ts`).
2. **Options, under Sites, on the site's card.** Add the new domain (access is requested), then
   remove the old one (its access is revoked). A library recipe is forked locally under the same id,
   so the next library sync cannot undo the edit.
3. **A contributed recipe.** Add the new hostname to `hostnames`, and keep the old one while it
   still resolves.

A recipe with no `hostnames` matches any host on its pattern and fingerprint alone. That is the
clone-resilient escape hatch, not the default. The picker always writes a host scope.

## Contribution mechanics

Only site config is contributable: recipes and quick links. Corrections, manual picks, and the
crosswalk overrides reveal what the user watched, so they never leave the device.

The extension builds a self-describing payload into a prefilled GitHub issue. The user submits it
with their own GitHub login, and no backend is involved:

```json
{ "kind": "recipe", "tracker": "trakt", "action": "add", "id": "cineby", "schemaVersion": 3, "data": {} }
```

Local-only fields (`source`, `enabled`) are already stripped, so the data is library-shaped. A
large bundle exceeds the issue URL limit, so TMSync copies the JSON and the issue asks the user to
paste it.

`.github/workflows/contribution.yml` runs `scripts/apply-contribution.mjs` when a maintainer adds
the `contribution` label (or opens an issue that already has it). Outsiders cannot add labels, so
every outside contribution waits for a maintainer check. The script routes recipes to `recipes[]`
and quick links to `links[]`, adds by id (an existing id is an update, never a silent duplicate),
formats the file, and opens a PR on a content-keyed branch, so re-contributing the same site
updates its PR. It comments on the issue with the PR link. This is repo automation, not a hosted
service. Schema validation stays with the tests: a malformed entry is dropped by `parseLibrary` and
the tests fail, which blocks the merge. Two different sites editing the same array can still
conflict, and a human resolves that.

**Graduation.** When a contribution merges, the library keeps its id. On the next refresh an
identical local recipe is retired, so it stops using sync quota. An identical local quick link
becomes a library entry and keeps the user's enable or disable toggle. If the user edited their
copy after contributing, the local copy stays and keeps shadowing the library one.
