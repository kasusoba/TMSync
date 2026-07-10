# Identity namespaces & stable recipe ids

Status: **implemented** (schema v3). Supersedes the single `extract.tmdbId` field and
the timestamped `custom-<host>-<ts>` recipe id. Read alongside `MULTI-TRACK.md`
(native-vs-derived) and `CLAUDE.md` → "Tracker adapters".

## Why

The old model made **tracker** (`trakt` / `anilist`) the organizing axis for identity:
`extract.tmdbId` was the one id a page could expose, and the file split was "Trakt list
vs anime list." Multi-tracking broke that framing — an anime site (Miruro) exposes a
**TMDB id** yet writes to **both** trackers. A tracker is a *destination*; destinations
are derived and will grow. What's actually invariant is the site's **source identity**:
*which id catalog the page hands you*. That's the axis this design keys on.

Three independent axes, not one:

| axis | question | example (Miruro) |
|---|---|---|
| **identity namespace** | what id does the page expose? | `tmdb` |
| **catalog** | which recipe list / file? | anime |
| **tracker(s)** | where does it write? | Trakt (native) + AniList (derived) |

Keeping these separate is the whole point — see "Miruro" below.

## Identity namespaces

`IdNamespace` (`packages/shared/src/schema.ts`) is an **open** enum, grown like the
tracker list — never frozen at a fixed set:

```
tmdb | imdb | tvdb | anilist | mal        (+ more as adapters need them)
```

- `imdb` ids are **strings** (`tt1375666`); the rest are numeric.
- `none` is not a member — it's the *absence* of any id (title-only path).
- "a site's own / absolute number" is not a member — no tracker can resolve it. It stays
  the `manualKey` / `canonical` local-cache-key path plus the quarantined `lib/animap`
  crosswalk. Putting it here would lie about resolvability.

### On the recipe: a per-field map, not a single tag

Identity is a **set** of optional fields on `extract.ids`, because one page often exposes
several ids at once. Resolution tries them best-first — it is not a single "this recipe's
namespace" tag.

```jsonc
"extract": {
  "title": { "source": "dom", "selector": "h1" },
  "ids": {
    "tmdb": { "source": "url", "regex": "/tv/(\\d+)", "transforms": ["toInt"] },
    "imdb": { "source": "meta", "selector": "imdb:id" }
  }
}
```

A recipe needs **a title or at least one id** (`extract` refine). `extract.ids` reads into
`ParsedMedia.ids: Partial<Record<IdNamespace, string | number>>`.

### On the adapter: `resolvableNamespaces`

Each `TrackerAdapter` declares which namespaces it resolves **directly (native)**,
strongest first:

| adapter | resolvableNamespaces |
|---|---|
| Trakt | `["tmdb", "imdb", "tvdb"]` |
| AniList | `["anilist", "mal"]` |

Adding a tracker = a new adapter + its `resolvableNamespaces` (+ maybe an animap entry).
The shared engine never learns a new namespace by hand.

## Resolution order (every adapter, one ladder)

```
1. NATIVE id  — the first namespace in resolvableNamespaces that media.ids has → exact lookup
2. DERIVED id — an id in ANOTHER namespace the crosswalk (lib/animap) maps into one of mine
                (best-effort, refuse-on-ambiguous, skip-on-miss) — quarantined in the adapter
3. TITLE      — fall back to a title (+year/season) search
4. null       — hand off to the user-correction picker
```

This is exactly the existing **native → derived → title** ladder, generalized. Native (1)
lives in each client's `resolve`; derived (2) is the multi-track fan-out
(`deriveMediaWith` + `resolveAcross`/`recordDerivedTrackers` in the background).

## Miruro — proof that namespace ≠ tracker

Miruro extracts a **`ids.tmdb`**, yet routes to AniList (and, multi-tracked, to both). So the
tracker a recipe writes to is **not** derived from the id namespace it scrapes — it's the
recipe's own `tracker`/`trackers` field. There is no separate anime file and no `catalog`
concept: all recipes live in one `recipes/index.json`, routed per-recipe at runtime.

## Stable, human-readable recipe ids

Old id: `custom-<host>-<Date.now()>` — unique **per device**, so two users contributing the
same site produced different ids → silent duplicate entries in the shared list (worse than a
conflict). New id: a **host slug** (`www.miruro.to` → `miruro-to`), disambiguated `-2`, `-3`
on collision (`lib/recipe-id.ts`).

The id is **not a foreign key** anywhere — corrections key on the scraped media
(`resolutionCacheKey`), quick links carry their own ids, no store references a recipe id — which
is why ids can be regenerated freely. (The one-time v1→v2 id migration was removed once the
installed base — a single user — no longer needed it.)

## Contribution flow

- **Routing**: every contribution lands in the single `recipes/index.json` —
  `scripts/apply-contribution.mjs` adds recipes to `recipes[]` and quick links to `links[]`.
  Each recipe's own `tracker` field routes it at runtime; there's no per-tracker file.
- **Content-keyed branch**: a single-site contribution opens `contribution/<stable-id>`, so
  re-contributing the same site **updates its PR** instead of racing a duplicate. A bundle
  (`contributeAll`) falls back to `contribution/issue-<n>`.
- Conflicts between **different** sites editing the same array are still expected and are
  resolved by hand — that's the deliberate trade (no generated index).

## Back-compat & versioning

`SCHEMA_VERSION = 3`. A v≤2 recipe's `extract.tmdbId` is folded into `ids.tmdb` by the schema
transform (an explicit `ids.tmdb` wins), so old cached/user/contributed recipes keep parsing.
The alias is not re-emitted — anything re-serialized comes out in the `ids` shape.

## Scope / not-yet

- The **picker auto-detects TMDB ids only** (the common case) and stores them under
  `ids.tmdb`. Other namespaces (`imdb`/`tvdb`/`anilist`/`mal`) are hand-authorable in a
  recipe today; the picker can grow to detect them without any schema change.
- The AniList adapter resolves a native `anilist` id (`Media(id:)`) or a `mal` id
  (`Media(idMal:)`); a `tmdb` page id reaches AniList only through the crosswalk (derived).
