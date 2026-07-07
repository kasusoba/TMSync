# RECIPE-LIFECYCLE.md — evolving recipes without breaking existing ones

**Status:** reference (2026-07). How recipes are versioned, distributed, and maintained over time — so future iteration (new fields, new heuristics, site rot) is a settled process, not an ad-hoc scramble.

The short version: **existing recipes don't break when we iterate**, because changes are additive by default and gated by a per-recipe `schemaVersion`. The recipe **library** lives in this repo and ships over a CDN, so a fixed recipe reaches every user *without* an extension update. The real ongoing cost isn't versioning — it's **site rot**.

---

## 1. Two version axes — never conflate them

| | Where it lives | What it gates | When it changes |
|---|---|---|---|
| **`schemaVersion`** | on every recipe (`SCHEMA_VERSION`, currently `2`) | the *shape* of recipe data | only when a change would make an old client mis-read a recipe |
| **Extension version** | `packages/extension/package.json` | the app build | every release — and **never appears on a recipe** |

A recipe is data shared across many extension versions. Stamping the extension version onto it would couple two things that evolve on different clocks. The recipe's own `schemaVersion` is the only version a recipe carries.

**The forward-compat guard already exists** (`selectRecipe` in `packages/shared/src/match.ts`):

```ts
if (recipe.schemaVersion > SCHEMA_VERSION) continue; // too new for me → skip, don't crash
```

So an old client **safely ignores** recipes it's too old to understand, and a new client reads old recipes through schema defaults. That two-way contract is the whole game.

## 2. The additive-vs-breaking rule

Before changing the schema, classify the change:

- **Additive + old clients degrade gracefully** → *no bump.* A new **optional** field that old clients simply ignore, defaulting sensibly. Examples already shipped this way: `tracker` (v1→v2 default `"trakt"`), `trackers[]` (absent ⇒ `[tracker]`). Document the default next to the field.
- **Breaking for old clients** → *bump `SCHEMA_VERSION`.* Anything an old client would crash on or silently misinterpret: a **new `Transform` enum value**, a new **required** field, a renamed field, or changed semantics of an existing field. New recipes carry the higher version; old clients skip them via the guard above.

> Litmus test: *would a client one version behind produce a wrong scrobble (not just a skipped one) if it read this recipe?* If yes → bump. If it would only skip or safely default → additive.

Note: adding a new `source`/`Transform` value is **breaking** even though it "feels" additive — an old client's Zod parse rejects the unknown enum, so the recipe must be marked with a higher `schemaVersion` to keep old clients from choking on it mid-list.

## 3. Where recipes live

- **User custom recipes** → local `customRecipes` storage. They never leave the browser (privacy, constraint #6). The client that authored a custom recipe always supports its schema, so the "old client, new recipe" case doesn't arise for them.
- **Library recipes** → this repo (`recipes/trakt/`, `recipes/anime/`), PR-contributed (the in-extension *Contribute* button files an issue that `.github/workflows/contribution.yml` turns into a PR), **served from CDN**, refreshed client-side on a 12h alarm (`browser.alarms` → `refreshRecipes`).

**The CDN decoupling is the superpower:** fixing a rotted library recipe ships to every user on their next refresh, with no extension release. Recipes and the app evolve independently.

## 4. Recipe rot is the real maintenance burden

Schema churn is rare and mechanical. What you actually fight is **sites changing their DOM/URL**, which rots a recipe's selectors or `urlPattern`. The loop:

1. **Detect** — a recipe-snapshot test (saved HTML + expected `extract()` output, fixtures in `packages/extension/test/fixtures/`) goes red in CI, *or* a user hits a bad parse in the wild. Add a snapshot fixture for every high-traffic site early — it's the cheapest tripwire.
2. **Fix** — re-pick with the element picker and contribute the updated recipe (PR, or the Contribute button).
3. **Ship** — merge → CDN serves it → clients pick it up on next refresh. No release.

A change to `suggestUrlPattern` (or any picker heuristic) does **not** rot existing recipes — heuristics only run when a recipe is *authored*. Saved recipes keep their stored `match`. (This is why the recent typed-id `urlPattern` improvement broke nothing.)

## 5. Migration playbook — when a break is genuinely needed

Do both halves together:

- **Custom recipes** — add a versioned WXT storage migration that transforms old local recipes to the new shape on upgrade (read-time or one-shot). This is the only way to move data users own.
- **Library recipes** — regenerate the JSON lists at the new `schemaVersion`. Optionally keep both tiers live during the transition (old + new recipes side by side) so not-yet-updated clients keep working until they catch up, then drop the old tier.

## 6. Worked example — one recipe or two? (the mental model)

Whether a site needs **one** recipe or **two disjoint** ones is decided by *whose numbering the site speaks* (see `docs/MULTI-TRACK.md`, native-vs-derived), not by how many media types it hosts.

### A. TMDB-native site, type encoded in the URL → **two disjoint recipes**

Aether: `aether.bar/media/tmdb-tv-2604-…` and `aether.bar/media/tmdb-movie-1244492-…`.

- Movie and TV are **different TMDB id namespaces**, and **Trakt distinguishes movies from shows** — so a movie recipe and a show recipe are genuinely different resolutions.
- Both pages share the base path `…/media/…`, so a naïve `urlPattern` (`aether\.bar/media`) matches both → the second recipe would clobber the first.
- **Resolution:** the picker keeps the typed-id prefix, so the two recipes come out disjoint automatically — `aether\.bar/media/tmdb-tv-` vs `aether\.bar/media/tmdb-movie-` — each generated from its own page. Two recipes, no hand-written regex.

### B. AniList-native slug site, "a movie is episode 1" → **one recipe**

A dedicated anime site where series and movies share one URL shape and a movie is just *episode 1*.

- **You don't distinguish them, because AniList doesn't.** An AniList movie entry is a single-episode entry (`episodes: 1`); scraping `episode 1` and writing `progress 1` marks it **COMPLETED** — the exact same path as the last episode of a series.
- The **derived Trakt** side gets the movie/series split for free from the reverse crosswalk: `animap.reverse(anilistId)` returns `tmdbKind: "movie" | "tv"`, so `deriveMedia` emits a Trakt movie or a show episode. The AniList entry's identity *is* the type signal.
- **Authoring rule:** `mediaType: "auto"` (or `"show"`) and **always scrape `episode`**. Never `mediaType: "movie"` — `buildRecipe` drops season/episode for movies, leaving AniList with no episode to write.
- **Only real risk:** resolution ambiguity when a series and a movie share a title — handled by the correction/pin system, not the recipe.
- **Label:** a resolved **single-episode** entry drops the `E1` — the reply carries `resolvedEpisodes`, and the badge omits the episode suffix when it's `1` (the number is always 1, i.e. no information). This covers a movie *and* a 1-ep OVA/special; a precise "is a movie" test would need AniList's `format` field, which we don't fetch and the label doesn't need.

> Rule of thumb: **TMDB-native + Trakt-cares-about-type → split by `urlPattern`. AniList-native → one recipe; the crosswalk untangles Trakt.**
