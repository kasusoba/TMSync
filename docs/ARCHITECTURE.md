# TMSync — Architecture

A plain-English tour of how the code actually works, subsystem by subsystem. It complements
[`CLAUDE.md`](../CLAUDE.md) (the *rules and constraints*) and [`TMSync-PRD.md`](./TMSync-PRD.md)
(the *what and why*). This file is the *how* — read it when you need to answer "where does X
happen?" or "what talks to what?".

> Scope note: TMSync tracks **movies & non-anime TV → Trakt** and **anime series → AniList**, and
> can **multi-track anime to both at once**. The tracker layer is a pluggable registry; the
> long-term vision is more trackers (Simkl, MyAnimeList) behind the same seam. Everything below
> reflects the code as it stands today.

---

## 1. The mental model in one minute

TMSync watches a `<video>` on a streaming page, figures out *what* is playing from the page's own
metadata (using a **recipe** — declarative JSON, never code), and reports your progress to the
right tracker(s). Three moving parts:

- **The content script** runs *on the page*. It matches a recipe, finds the video, reads the
  title/season/episode, draws the on-page badge, and owns the live watch session (play/pause/stop).
- **The background service worker** is the *hub*. It resolves "Attack on Titan S1E5" into a real
  Trakt/AniList id, calls the tracker APIs, holds your OAuth tokens, and refreshes the recipe
  library. It is **stateless** — it forgets everything between wake-ups and re-reads storage each
  time (an MV3 requirement).
- **`@tmsync/shared`** is a *pure* package (no DOM, no browser APIs): the recipe schema, the
  `extract()` engine, and helper logic. It's the testable core, and could be reused server-side one
  day.

Everything tracker-specific (auth, id resolution, how progress is recorded, the anime numbering
crosswalk) hides behind a **tracker-adapter seam** so the shared engine never needs to know Trakt
from AniList.

```
┌─────────────────────────────── the streaming page ───────────────────────────────┐
│  content script (per frame, injected per-origin at runtime)                       │
│    matchRecipe → extract() → ParsedMedia → badge                                  │
│    SessionManager + ScrobbleController  (play / pause / stop, debounced)          │
└──────────────┬────────────────────────────────────────────────────────────────────┘
               │  typed messages (@webext-core/messaging)
               ▼
┌─────────────────────────── background service worker (stateless) ─────────────────┐
│   routeTracker → TrackerAdapter(s)                                                 │
│     Trakt adapter  → Trakt REST  (real-time scrobble start/pause/stop)            │
│     AniList adapter → AniList GraphQL (one SaveMediaListEntry at threshold)        │
│     animap crosswalk → multi-track fan-out (anime → both)                          │
│   reads/writes WXT storage for everything (tokens, caches, sessions)              │
└────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Repo shape

pnpm workspace, two packages plus a recipe library:

| Path | What it is |
|---|---|
| `packages/shared/` | **Pure engine + schema.** No DOM, no browser globals. Zod recipe schema, `extract()`, matching, transforms, quick-link templates. The testable core. |
| `packages/extension/` | **The WXT app.** All entrypoints, the tracker adapters, the session/scrobble machine, storage, UI kit, element picker. Preact for injected UI. |
| `recipes/index.json` | One **tracker-agnostic** recipe + quick-link library (crowdsourced via PR). Trakt and AniList recipes coexist; each carries its own `tracker` field and the engine routes per-recipe. |

Root `package.json` scripts just delegate into the extension package via `pnpm -F @tmsync/extension`.

---

## 3. The life of a scrobble (end-to-end)

This is the single most useful thing to understand — trace one watch from page load to "marked
watched". Follow the numbers:

1. **Injection.** The content script (`entrypoints/content.tsx`) is registered *per-origin at
   runtime* — it isn't on every page by default (constraint #5: no broad host access at install).
   You grant a site in the popup, which registers the script for that origin.
2. **Match.** On load it calls `loadRecipes()` and `selectRecipe()`/`matchRecipe()`
   (`packages/shared/src/match.ts`): the first enabled recipe whose `match.hostnames` covers the
   page's host, whose `urlPattern` regex matches, and whose `domFingerprint` selector exists. The
   host lives in `hostnames`, so a site that moves domain keeps its recipe and gains a hostname
   (docs/RECIPE-LIFECYCLE.md §4b). The fingerprint is the *clone-resilient* key: it matches a site
   across its mirror domains, and it is what lets the badge offer a known recipe on a new domain.
3. **Extract.** `extract(recipe, { document, url })` (`packages/shared/src/extract.ts`) reads each
   field from its `source` (`url` / `meta` / `jsonld` / `dom` / `title`), applies `regex` → `group`
   → `transforms`, and returns a `ParsedMedia` (`{ mediaType, title, year?, season?, episode?,
   ids? }`). It **never throws** — a bad selector just yields `null`.
4. **Badge + session.** The top frame mounts the Shadow-DOM badge and starts a `SessionManager`
   (`lib/scrobble/session.ts`). If the player is in a cross-origin iframe (common on gray-market
   sites), the *matching* frame publishes the media for the tab and the *video-owning* frame pulls
   it — they coordinate over messaging.
5. **Route.** The background decides which adapter(s) get this item via `routeTracker()` /
   `recipeTrackers()`. Movies always route to Trakt; an anime recipe can route to **both** Trakt and
   AniList (multi-track fan-out).
6. **Resolve (once, cached).** The adapter turns the `ParsedMedia` into a `TrackedItem`: Trakt via
   `/search` (returns trakt/imdb/tmdb ids), AniList via a GraphQL `Media` search. Results are
   cached in storage so this only happens once per title.
7. **Record progress.** `ScrobbleController` (`lib/scrobble/controller.ts`) is the play/pause/stop
   state machine on the video element. It debounces bursts (seeking, ad breaks), fires exactly one
   `start` per session, and commits a `stop` the moment progress crosses `watchedThreshold`.
   - **Trakt** path: real-time `POST /scrobble/start|pause|stop`. Trakt owns the "watched" decision
     (≥80% on stop → history).
   - **AniList** path: no scrobble API exists, so start/pause are no-ops and a single
     `SaveMediaListEntry` write happens once the threshold is crossed. *We* own the watched decision
     here.
8. **Survive a crash.** Progress is throttle-persisted to session storage (`tabSessions`) every ~5s.
   If the tab dies before a clean stop, the background's `tabs.onRemoved` handler re-resolves and
   replays a reconciling `stop` from the last persisted progress. This is *why* session state lives
   in the content script + storage, never in background memory.

---

## 4. The engine — `packages/shared/`

The heart of the "recipes are data, not code" guarantee. Everything here is pure and unit-tested.

- **`extract.ts`** — `extract(recipe, ctx)`. The `Document` is *injected* via `ctx`, which is how
  this stays DOM-global-free (and testable with `happy-dom`). Field pipeline: `rawValue` (switches
  on `source`) → `applyRegex` → `applyTransforms` → trim. `readField` is exported so the picker can
  show a live preview using the exact same logic that runs in production. `readJsonLd` flattens
  arrays and `@graph` and walks dotted paths. `readIds` builds a namespace-keyed id map; `primaryId`
  picks the strongest id by `ID_NAMESPACE_ORDER` (tmdb, imdb, tvdb, anilist, mal).
- **`match.ts`**: `matchRecipe` (host scope + urlPattern + domFingerprint) and `selectRecipe`
  (first match whose `schemaVersion ≤ SCHEMA_VERSION`), plus `findHostAdoption` (a recipe that fits
  the page except for the hostname, which is what a moved site looks like).
- **`hosts.ts`**: the one place that reads and rewrites a recipe's host: `recipeHosts`,
  `withRecipeHosts`, and the parser for the host anchor older patterns carry.
- **`schema.ts`** — the Zod source of truth. `SCHEMA_VERSION = 3`. A recipe is validated here before
  it's ever used; an invalid recipe is discarded, never partially applied. `recipeTrackers()` reads
  the multi-track set (`trackers` if present, else `[tracker]`). Schema evolution is handled with
  Zod `.transform`s for back-compat (e.g. legacy `tmdbId` folds into the open `ids` map).
- **`transforms.ts`**, **`recipes.ts`** (parse/validate untrusted library JSON, discarding bad
  entries individually), **`links.ts`** (quick-link URL templating), **`types.ts`** (`ParsedMedia`,
  `EngineContext`, `ExtractResult`).


---

## 5. Tracker adapters — the seam that keeps Trakt and AniList apart

`lib/tracker/adapter.ts` defines the contract; `lib/tracker/index.ts` is the routing single source
of truth (`getAdapter`, `routeTracker`, `inferNativeTracker`). Two implementations behind it:

| | **Trakt** (`lib/trakt/`) | **AniList** (`lib/anilist/`) |
|---|---|---|
| Progress | real-time scrobble `start`/`pause`/`stop` | none — one `SaveMediaListEntry` per episode at threshold |
| Watched decision | Trakt owns it (≥80% on stop) | *we* own it (crossing `watchedThreshold`) |
| Auth | OAuth authorization-code, refresh-token rotation | OAuth authorization-code, ~1-year token, no refresh |
| Identity | `/search` → trakt/imdb/tmdb ids | GraphQL `Media` search → AniList id |
| Resolvable ids | tmdb, imdb, tvdb | anilist, mal |

**Why they're deliberately different code paths:** AniList has no concept of "currently watching",
so faking a scrobble loop for it would be wrong. It reads the viewer's existing list entry *before
every write* (the entry is the source of truth), never lowers `progress`, and treats a `COMPLETED`
season as sacred — re-watching prompts a "Rewatching?" confirmation in the badge before it touches
anything. That decision logic is pure and tested in `lib/anilist/util.ts` (`planAniListWrite`).

**The anime crosswalk (`lib/animap/`).** When an anime is multi-tracked, one tracker is *native*
(the page already speaks its numbering) and the other is *derived* via the Fribb TMDB↔AniList
crosswalk (`anime-map.seed.json`). `forward()`/`reverse()` return `resolved | ambiguous | miss` and
**never guess** — ambiguous or missing means skip that tracker, not mis-write it. The fan-out itself
(`recordDerivedTrackers`, `resolveAcross`) lives in `background.ts`. **Hard rule:** the crosswalk is
background-side only and must never be imported by the shared engine.

**Rating, notes & exports** are co-located with each tracker, not inlined in the background: Trakt
rating/notes in `lib/trakt/review.ts`, AniList in `lib/anilist/review.ts`, and Trakt's Letterboxd
CSV export in `lib/trakt/letterboxd.ts`. The background's `rateItem`/`saveNote`/etc. handlers are
thin dispatchers that call the right tracker's module. (The `TrackerAdapter` interface itself covers
resolve/record/ratingLevels/watchedState; folding rate/note *writes* into the interface is a future
step best done when a third tracker exists to shape it.)

---

## 6. Session & scrobble machine — `lib/scrobble/`

- **`session.ts` — `SessionManager`** (per frame). The messy real-world glue: the matcher/player
  iframe split, SPA navigation (it patches `history.pushState`/`replaceState`), late metadata
  (watches `<head>` mutations for a late `og:title`), hover-gated player chrome (it can even
  synthesize pointer nudges to make lazy players render their metadata), manual recipes, and
  episode-less URLs (prompts for the episode). It also collects cross-origin iframe origins so the
  popup can offer to grant them.
- **`controller.ts` — `ScrobbleController`** (the actual state machine). Debounces play/pause bursts
  (~800ms), is idempotent (never fires the same action twice), turns a late pause into a stop, and
  `progressTick()` commits the stop the instant progress crosses the threshold — robust against
  players that never fire `ended`.
- **Ownership:** `claimScrobbleOwner` guarantees exactly one scrobbling frame per tab (5-min TTL),
  so an iframe player and the top page don't double-scrobble.

---

## 7. Messaging — `packages/extension/messaging.ts`

One typed `ProtocolMap` (~40 messages) via `@webext-core/messaging` — no ad-hoc `postMessage`. It's
the contract for content↔background↔popup/options. Content→background carries `scrobble`,
`publishMedia`, `updateProgress`, `endSession`, resolve/rate/note/correction messages;
background→content carries `recheck` and `scrobbleStatus`; popup/options→background carries status,
connect, search, and register/unregister. All handlers live in `background.ts`.

---

## 8. Storage — `packages/extension/lib/storage.ts`

Every persisted value is a `storage.defineItem`, split by prefix:

- **`sync:`** — small, cross-device, user-owned: `custom_recipes`, `quick_links`, `corrections`,
  `manual_selections`, `badge_prefs`.
- **`local:`** — per-device secrets/caches/regenerable: `trakt_tokens`, `anilist_tokens`,
  resolution caches, ratings/notes caches, `remote_recipes`, `enabled_origins`, `animap_overrides`.
- **`session:`** — ephemeral per-tab: `tab_sessions` (the crash-reconcile source of truth),
  `tab_frame_origins`, `tab_status`, `manual_contexts`, `episode_overrides`.

The background reads these fresh on each wake — there is no in-memory background state (constraint
#4).

---

## 9. UI — `packages/extension/lib/ui/`

- **`kit/kit.tsx`** — the shared design system: `tokens(variant)` (light/dark token maps), and
  primitives `Btn`, `IconBtn`, `Switch`, `Stars`, `Icon`, `TraktMark`, `AniListMark`. Dark is the
  shipped direction.
- **`kit/*View.tsx`** — presentational views (`PopupView`, `OptionsView`, `PickerPanel`,
  `BadgeView`, `QuickLinksView`, …). They take mock-able props and hold no browser APIs, which is
  what lets the **gallery** (`entrypoints/gallery/`) render every surface + state with fake data as
  a live component catalog.
- **`badge.tsx`** — the injected on-page badge, mounted via WXT's `createShadowRootUi` for Shadow
  DOM style isolation. Notable tricks: `keepAboveModals` re-parents the shadow host into an active
  `<dialog>` top-layer so the badge stays clickable over site modals; drag-to-edge docking with FLIP
  animation; a key-shield so page shortcuts don't leak.

---

## 10. Element picker — `lib/picker/`

How a new site gets added without code. `recipe-builder.ts` is pure authoring logic:
`autoDetectFields` (tries og/jsonld/title first, using the real `readField`), `suggestUrlPattern`,
regex/number/title chip builders, `buildRecipe` (assembles + Zod-validates), and `previewDraft`
(runs the *actual* `extract()` for a live preview). `PickerApp.tsx` is the overlay UI — it uses
`@medv/finder` to turn a clicked element into a short, robust CSS selector, and saves the result to
`custom_recipes`, reflecting live into the running content script.

---

## 11. Build, test, distribution

- **WXT** (`packages/extension/wxt.config.ts`): Preact + Tailwind v4. Minimal install permissions
  (`storage, alarms, scripting, identity, activeTab`) + specific host perms (Trakt, AniList, the
  recipe CDN); broad access is `optional_host_permissions` requested per-origin on a gesture. A
  `build:manifestGenerated` hook strips WXT's derived broad host perms and re-expresses them as
  optional. A committed extension `key`/`gecko.id` keeps the extension id — and thus the OAuth
  redirect URI — stable.
- **Multi-browser:** `dev` / `dev:firefox` / `build` / `build:firefox` / `zip*`; outputs under
  `.output/`.
- **Tests:** Vitest (`happy-dom`) for the ~19 colocated unit suites (engine, schema, match,
  controller, animap, recipe-builder, clients, …); Playwright for the E2E perf regression
  (`e2e/perf.e2e.ts`). `pnpm test` runs both packages.
- **TS:** strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Biome for lint/format.

---

## 12. Known rough edges (honest list)

Not blockers — just the things a careful reader might notice, so you're never caught off guard.

**One known limitation (deferred by choice):**

- **Picker vs schema id mismatch.** The schema supports an open multi-id `ids` map, but the picker
  draft still carries a single id under a heuristically-chosen namespace. Bridged, and fine for v1's
  dedicated sites — a full multi-namespace authoring UI is deliberately deferred until there's a
  concrete need.

**Recently cleaned up** (kept here as a record of what changed):

- `inferNativeTracker`'s dead branch — collapsed to a single fallback.
- ETag conditional refetch — now wired (`If-None-Match` + 304 handling in `fetchRemoteRecipes`).
- AniList/Trakt rating/notes — moved out of `background.ts` into `lib/anilist/review.ts` and
  `lib/trakt/review.ts`; the background handlers are thin dispatchers.
- The "crosswalk" name collision — the quick-link slug cache is now `quickLinkSlugs`
  (`local:quicklink_slugs`), distinct from the `lib/animap/` numbering crosswalk.
- Letterboxd CSV export — moved out of the pure `shared` package into `lib/trakt/`.
- The `proto/` UI folder — renamed to `kit/`.
- Transitional one-time migrations — removed (the repo has a single user; no installed base to
  migrate).

---

## 13. "Where do I look when…" quick index

| You want to… | Start here |
|---|---|
| Change how a value is read off a page | `packages/shared/src/extract.ts` |
| Add/adjust a recipe field or transform | `packages/shared/src/schema.ts` + `transforms.ts` |
| Change how a site is matched | `packages/shared/src/match.ts` |
| Touch play/pause/stop timing | `lib/scrobble/controller.ts` |
| Touch iframe/SPA/late-metadata handling | `lib/scrobble/session.ts` |
| Add or change a tracker | `lib/tracker/adapter.ts` + a new `lib/<tracker>/` folder |
| Debug Trakt resolution/scrobble | `lib/trakt/client.ts`, `lib/trakt/auth.ts` |
| Debug AniList writes | `lib/anilist/client.ts`, `lib/anilist/util.ts` |
| Change rating / notes behaviour | `lib/trakt/review.ts`, `lib/anilist/review.ts` |
| Debug anime double-tracking | `lib/animap/` + `recordDerivedTrackers` in `background.ts` |
| Change the badge / picker / popup UI | `lib/ui/kit/` (+ `entrypoints/gallery/` to preview) |
| Change stored data or add a cache | `lib/storage.ts` |
| Add a message between parts | `packages/extension/messaging.ts` |
