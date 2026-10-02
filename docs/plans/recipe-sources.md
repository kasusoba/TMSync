# Plan: recipe sources (bring your own library)

Status: approved. Branch `feat/recipe-sources`. One PR.

## Goal

Remove the central recipe library. TMSync ships with no sites. A user adds **recipe sources**:
URLs to JSON files in the library format, run by anyone. This is the Mihon model. The project
publishes the engine, the picker, and the schema. It does not publish or link any list of sites.

Why:

- A first-party list of gray-market hostnames ties the project to piracy (repo, CDN, store
  review). An engine with a picker is neutral.
- Clone sites change domain every few weeks. A central list makes us the maintainer of that churn.
- The picker already makes a recipe in a few clicks, and a source URL is as easy to share as a PR.

What stays the same: recipes are data, parsed through Zod, never code (constraint #3). No
backend (constraint #7). The anime-map crosswalk stays in this repo and keeps its CDN fetch
(it is tracker metadata, not site data).

## What goes away

| Item | Today | After |
| --- | --- | --- |
| `recipes/index.json` | empty bundled seed + CDN list | deleted. `recipes/` keeps only `anime-map.json` |
| `RECIPES` in `config.ts` | CDN URL, refresh, contribute URL | deleted (refresh interval moves to `SOURCES`) |
| `fetchRemoteRecipes`, `local:remote_recipes` | one CDN list | replaced by per-source fetch + cache |
| `bundledLinks`, bundled seed in `lib/recipes/index.ts` | offline fallback | deleted |
| `graduateRecipes`, link graduation | retire a custom copy once its PR merged | deleted (nothing to graduate into) |
| `lib/portability/contribute.ts`, Contribute page | prefilled GitHub issue | replaced by "Share as a source file" |
| `QuickLinkSite.source: "library"` | link from the central list | `source: { id }` of the recipe source it came from |

## Data model

**Source list** (`sync:recipe_sources`, small, roams with the user):

```ts
interface RecipeSource {
  id: string;        // stable, generated at add time
  url: string;       // https only
  name?: string;     // from the file's `name`, else the URL host
  enabled: boolean;
}
// Array order IS priority: index 0 wins.
```

**Per-source cache** (`local:source_cache:<id>`): `{ recipes, links, fetchedAt, etag?, error? }`.
Validated with `parseLibrary` before it lands. A bad file keeps the previous cache and records
`error` for the UI.

**Site pins** (`sync:site_source_pins`): `Record<siteKey, sourceId>`. Only written when the user
picks a non-default source for a site (see Conflicts).

**Fork base** (`local:fork_base`): `Record<recipeId, { sourceId, hash }>`. Written when the user
edits a source recipe (which forks it into their custom recipes, as today).

**Source file format:** the existing library shape plus two optional top-level fields, `name` and
`homepage`. Recipe schema is unchanged, so no `schemaVersion` bump (check against the bump rule in
`docs/RECIPES.md` when doing step 1).

## Conflicts

Several sources can cover the same site. The rules, in order:

1. **Custom always wins.** Your own recipes (picker-made or forked) sit above every source, per
   target, exactly as custom sits above the library today.
2. **A site comes from ONE source, whole.** Sources are grouped into sites by shared host (the
   `groupSites` rule). For a site covered by several sources, take every recipe of that site from
   one source only. Mixing the movie recipe of source A with the TV recipe of source B gives
   behavior that neither author tested, so never do it.
3. **Which source:** the pinned one if the user pinned the site, else the highest source in the
   list. Reordering sources changes the default for every unpinned site.
4. **Same recipe id in two sources:** not a special case. Ids are compared inside a source only.
   Across sources, rule 2 already picked one.
5. **Overlap that grouping misses** (two different sites whose URL patterns both match one page,
   for example a host-free recipe): `selectRecipe` takes the first match, and the merged list is in
   priority order, so the result is predictable. The match diagnostics (`explainMatch`) already list
   the other candidates.
6. **Quick links:** the same id or host from two sources resolves like rule 3 (pin, else priority).
   A link the user edited is theirs (`source: "user"`) and is never overwritten.
7. **Stale fork:** when the source version of a forked recipe changes (hash differs from the fork
   base), the site row shows "The source has a newer version" with **Use source version** (drops the
   fork) and **Keep mine** (moves the base forward). Never auto-replace a fork.
8. **Source removed or disabled:** its recipes and links leave at once. Forks stay (they are
   custom). Pins pointing to it are ignored, then cleaned on the next write.

UI for conflicts: a site row in options shows which source it comes from. If other sources also
cover it, it says "Also in: B, C" and offers a source picker. Choosing one writes the pin.

## Fetching and permissions

- Background fetch per enabled source: TTL (12 h), `If-None-Match`, validated, best effort. An alarm
  refreshes all. "Refresh" in options forces one or all. No state held in the worker (constraint #4).
- **Host permission:** the extension can read a CORS-enabled URL without a permission. Known
  CORS hosts (`raw.githubusercontent.com`, `gist.githubusercontent.com`, `cdn.jsdelivr.net`) need
  nothing. Any other host: request an optional host permission for that origin in the Add click,
  before the first fetch, so the request keeps the user gesture.
- https only. A size cap (for example 1 MB) so a hostile file cannot fill storage.
- Privacy: fetching a source reveals the user's IP to its host, like any page. No watch data goes
  there (constraint #6). Say this in the add dialog in one line.

## Trust

A source is data, so the worst it can do is add recipes for sites. Origins still need a grant per
site, except under the broad grant. The existing new-sites nudge (`addedHosts`, `noteNewSites`)
already reports sites a refresh brings in. Keep it, and name the source in the nudge.

## Migration

- Drop `local:remote_recipes`.
- Quick links with `source: "library"`: convert to `source: "user"` so nobody loses a link.
- Forks of library recipes are already plain custom recipes. Nothing to do.
- Old backups that carry `libraryLinkToggles`: accept and ignore.

## Steps (one commit each)

1. **Shared.** Optional `name` and `homepage` on the library schema. Tests for parse with and
   without them.
2. **Storage.** `recipeSources`, per-source cache, `siteSourcePins`, `forkBase`. Migration above.
3. **Background.** `fetchSources` replaces `fetchRemoteRecipes`. Per-source link merge replaces
   `mergeLibraryLinks`. Delete graduation. Update `recipeOrigins`, the adopt flow, the watchers, and
   `content.tsx` to watch the source caches.
4. **Merge.** `loadRecipes` and `groupSites` take custom + ordered source caches + pins and apply the
   conflict rules. `SiteGroup` entries carry their origin (`custom` or a source id) instead of
   `library: boolean`. Unit tests for every rule in Conflicts.
5. **Options UI.** A Sources section: add by URL, one row per source (name, site count, last fetch,
   error, enable `Switch`, reorder and trash `IconBtn`s, Refresh). Site rows show their source,
   "Also in", the picker, and the stale-fork notice. Kit primitives only. Gallery states for each.
6. **Share.** Replace Contribute with "Share as a source file": pick sites, download or copy a valid
   source file. Delete `contribute.ts`, `RECIPES`, `recipes/index.json`, the bundled seed. Picker
   banner says the source name instead of "library". Popup copy that says "library" too.
7. **Backup.** Export and import the source list and pins (URLs, not the cached content).
8. **Docs.** `CLAUDE.md` (constraints #6 and #7, repo layout, the one-file drift guard),
   `docs/ARCHITECTURE.md` (no backend, layout, storage layers, merge), `docs/RECIPES.md`
   (distribution, contribution, graduation become sources and sharing), `CONTRIBUTING.md` (code PRs
   welcome, site lists not accepted), `README.md`. Then delete this plan.

Each step: `pnpm lint`, `tsc --noEmit`, `pnpm test`, `pnpm build`.

## Owner decisions

- **Add a source:** paste a URL. No deep link.
- **Example:** document one legal example site in `docs/RECIPES.md` as a format sample. It is not
  added by default.
- **Store listing:** reword it in this PR. The copy lives in the HTML comment at the end of
  `README.md` (short description) and the README "What it does" and "Getting started" sections
  (full description). Also drop "request a site" from the Discord line.
