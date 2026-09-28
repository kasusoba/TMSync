# TMSync Architecture

A plain-English tour of how the code works, subsystem by subsystem. Read it when you need to answer
"where does X happen?" or "what talks to what?". The hard rules live in
[`CLAUDE.md`](../CLAUDE.md). Recipe details are in [`RECIPES.md`](./RECIPES.md), and per-tracker API
facts are in [`TRACKERS.md`](./TRACKERS.md).

TMSync scrobbles movies and non-anime TV to Trakt and/or Simkl, and anime to AniList and/or
MyAnimeList (and to Trakt and Simkl too), all at once if the user wants. It works on arbitrary
streaming sites, including ones with no API. It exists because tools like MAL-Sync cover only anime,
and others are tied to official integrations and will not touch aggregator sites.

Four decisions shape everything below:

- **Recipes are data, not code.** A store policy and a security requirement. No remote code, ever.
- **No backend.** The recipe library is versioned JSON served from the repo. There is no server, no
  account, and no database.
- **Privacy.** Matching and scrobbling run on the user's machine. Watch data goes only to the user's
  own tracker accounts, and each item goes only to the trackers it is routed to.
- **No broad permissions at install.** Access to a site is requested per origin, on a user gesture.

---

## 1. The mental model in one minute

TMSync watches a `<video>` on a streaming page, figures out *what* is playing from the page's own
metadata (using a **recipe**, declarative JSON, never code), and reports your progress to the
right tracker(s). Three moving parts:

- **The content script** runs *on the page*. It matches a recipe, finds the video, reads the
  title/season/episode, draws the on-page badge, and owns the live watch session (play/pause/stop).
- **The background service worker** is the *hub*. It resolves "Attack on Titan S1E5" into a real
  Trakt/AniList id, calls the tracker APIs, holds your OAuth tokens, and refreshes the recipe
  library. It is **stateless**, it forgets everything between wake-ups and re-reads storage each
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
│     MAL adapter    → MAL REST (one my_list_status PATCH at threshold)             │
│     Simkl adapter  → Simkl REST (scrobble start/pause/stop, 20 s lock)            │
│     animap crosswalk → multi-track fan-out (anime → several trackers)              │
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
| `recipes/index.json` | One **tracker-agnostic** recipe + quick-link library (crowdsourced via PR). Recipes for every tracker coexist; each carries its own tracker set and the engine routes per-recipe. |
| `recipes/anime-map.json` | The TMDB to AniList crosswalk (with MAL ids), rebuilt weekly from Fribb's `anime-lists` by CI. |

Root `package.json` scripts just delegate into the extension package via `pnpm -F @tmsync/extension`.

---

## 3. The life of a scrobble (end-to-end)

This is the single most useful thing to understand: trace one watch from page load to "marked
watched". Follow the numbers:

1. **Injection.** The content script (`entrypoints/content.tsx`) is registered *per-origin at
   runtime*: it isn't on every page by default (constraint #5: no broad host access at install).
   You grant a site in the popup, which registers the script for that origin.
2. **Match.** On load it calls `loadRecipes()` and `selectRecipe()`/`matchRecipe()`
   (`packages/shared/src/match.ts`): the first enabled recipe whose `match.hostnames` covers the
   page's host, whose `urlPattern` regex matches, and whose `domFingerprint` selector exists. The
   host lives in `hostnames`, so a site that moves domain keeps its recipe and gains a hostname
   ([`RECIPES.md`](./RECIPES.md#maintenance-site-rot-and-domain-moves)). The fingerprint is the *clone-resilient* key: it matches a site
   across its mirror domains.
3. **Extract.** `extract(recipe, { document, url })` (`packages/shared/src/extract.ts`) reads each
   field from its `source` (`url` / `meta` / `jsonld` / `dom` / `title`), applies `regex` → `group`
   → `transforms`, and returns a `ParsedMedia` (`{ mediaType, title, year?, season?, episode?,
   ids? }`). It **never throws**: a bad selector just yields `null`.
4. **Badge + session.** The top frame mounts the Shadow-DOM badge and starts a `SessionManager`
   (`lib/scrobble/session.ts`). If the player is in a cross-origin iframe (common on gray-market
   sites), the *matching* frame publishes the media for the tab and the *video-owning* frame pulls
   it: they coordinate over messaging.
5. **Route.** The background decides which adapter(s) get this item from `recipeTrackers()` and
   `routeTracker()`. A cour tracker (AniList, MAL) records series only, so a movie on a cour site
   goes to Trakt. A recipe can name several trackers, and the item fans out to all of them.
6. **Resolve (once, cached).** The adapter turns the `ParsedMedia` into a `TrackedItem`: Trakt via
   `/search` (returns trakt/imdb/tmdb ids), AniList via a GraphQL `Media` search, MAL by id (or AniList's `idMal`) else
   MAL search, and Simkl not at all (see below). Results are cached in storage so this only happens
   once per title.
7. **Record progress.** `ScrobbleController` (`lib/scrobble/controller.ts`) is the play/pause/stop
   state machine on the video element. It debounces bursts (seeking, ad breaks), fires exactly one
   `start` per session, and commits a `stop` the moment progress crosses `WATCHED_THRESHOLD` (80%).
   - **Trakt** path: real-time `POST /scrobble/start|pause|stop`. Trakt owns the "watched" decision
     (≥80% on stop → history).
   - **AniList / MAL** path: no scrobble API exists, so start/pause only read the list entry, and a
     single list write (`SaveMediaListEntry` / `PATCH my_list_status`) happens once the threshold
     is crossed. *We* own the watched decision here.
8. **Survive a crash.** Progress is throttle-persisted to session storage (`tabSessions`) every ~5s.
   If the tab dies before a clean stop, the background's `tabs.onRemoved` handler re-resolves and
   replays a reconciling `stop` from the last persisted progress. This is *why* session state lives
   in the content script + storage, never in background memory.

---

## 4. The engine: `packages/shared/`

The heart of the "recipes are data, not code" guarantee. Everything here is pure and unit-tested.

- **`extract.ts`**: `extract(recipe, ctx)`. The `Document` is *injected* via `ctx`, which is how
  this stays DOM-global-free (and testable with `happy-dom`). Field pipeline: `rawValue` (switches
  on `source`) → `applyRegex` → `applyTransforms` → trim. `readField` is exported so the picker can
  show a live preview using the exact same logic that runs in production. `readJsonLd` flattens
  arrays and `@graph` and walks dotted paths. `readIds` builds a namespace-keyed id map; `primaryId`
  picks the strongest id by `ID_NAMESPACE_ORDER` (tmdb, imdb, tvdb, anilist, mal).
- **`match.ts`**: `matchRecipe` (host scope + urlPattern + domFingerprint) and `selectRecipe`
  (first match whose `schemaVersion ≤ SCHEMA_VERSION`).
- **`hosts.ts`**: the one place that reads and rewrites a recipe's host: `recipeHosts`, `siteLabel`,
  `withRecipeHosts`, and the parser for the host anchor older patterns carry.
- **`schema.ts`**: the Zod source of truth. `SCHEMA_VERSION = 4` (v4 adds the MAL and Simkl trackers; a recipe that names one carries 4, others stay at 3, see `minSchemaVersion`). A recipe is validated here before
  it's ever used; an invalid recipe is discarded, never partially applied. `recipeTrackers()` reads
  the multi-track set (`trackers` if present, else `[tracker]`). Schema evolution is handled with
  Zod `.transform`s for back-compat (e.g. legacy `tmdbId` folds into the open `ids` map).
- **`transforms.ts`**, **`recipes.ts`** (parse/validate untrusted library JSON, discarding bad
  entries individually), **`links.ts`** (quick-link URL templating), **`types.ts`** (`ParsedMedia`,
  `EngineContext`, `ExtractResult`).


---

## 5. Tracker adapters: the seam that keeps the trackers apart

`lib/tracker/adapter.ts` defines the contract; `lib/tracker/index.ts` is the routing single source
of truth (`getAdapter`, `routeTracker`, `inferNativeTracker`). Four implementations behind it.
`TRACKER_INFO` holds each tracker's metadata (label, numbering **family**; see below). It also says what each
tracker rates (`levels` or the whole `entry`) and what note it keeps (`public`, `private`,
`none`); the rating panel reads those, not tracker names.

| | **Trakt** (`lib/trakt/`) | **AniList** (`lib/anilist/`) | **MyAnimeList** (`lib/mal/`) | **Simkl** (`lib/simkl/`) |
|---|---|---|---|---|
| Progress | real-time scrobble `start`/`pause`/`stop` | none, one `SaveMediaListEntry` per episode at threshold | none, one `PATCH my_list_status` per episode at threshold | real-time scrobble, one call per 20 s |
| Watched decision | Trakt owns it (≥80% on stop) | *we* own it (crossing `WATCHED_THRESHOLD`, 80%) | *we* own it (same planner) | Simkl owns it (≥80% on stop) |
| Auth | OAuth authorization-code, refresh-token rotation | OAuth authorization-code, ~1-year token, no refresh | authorization code + PKCE, no secret, refresh on 401 / near expiry | AUTH V2 code + PKCE (S256), no secret, 7-day token, refresh + revoke |
| Identity | `/search` → trakt/imdb/tmdb ids | GraphQL `Media` search → AniList id | MAL id, AniList `idMal`, else MAL search | none: each write sends ids + title + year; the match is cached from the reply |
| Resolvable ids | tmdb, imdb, tvdb | anilist, mal | mal | all (only when alone) |
| Host access | install manifest | install manifest | optional, asked on Connect | none (CORS) |

**Why they're deliberately different code paths:** AniList has no concept of "currently watching",
so faking a scrobble loop for it would be wrong. It reads the viewer's existing list entry *before
every write* (the entry is the source of truth), never lowers `progress`, and treats a `COMPLETED`
season as sacred: re-watching prompts a "Rewatching?" confirmation in the badge before it touches
anything. That decision logic is pure, tested, and shared by AniList and MAL in
`lib/tracker/cour-plan.ts` (`planCourWrite`); each adapter maps the plan to its own fields.

### Multi-tracking: native and derived

An item can be written to every enabled tracker at once. Trackers group by how they number
episodes, and that decides how an item moves between them:

| family | trackers | numbering | ids |
|---|---|---|---|
| `seasoned` | Trakt | season + episode | tmdb, imdb, tvdb |
| `cour` | AniList, MyAnimeList | one entry per cour, linear episodes | anilist, mal |
| `any` | Simkl | takes either, and maps anime itself | all of the above |

- **Inside a family**, only the id changes and the episode carries over as scraped. AniList and MAL
  map one to one through `Media.idMal`.
- **Across families**, the crosswalk bridges (below). It is written once, family to family, not per
  tracker pair.
- **`any` never uses the crosswalk.** Simkl gets the page's own numbering and ids as they are.

Every page has a **native** tracker: the one whose numbering the page already speaks. It is written
directly. Every other enabled tracker is **derived**. Native is inferred at scrobble time by
`inferNativeTracker`, never picked by the user: a page id in a tracker's `resolvableNamespaces`
wins, a scraped season means the first enabled seasoned tracker, and a bare linear episode (a
dedicated anime site) means the first enabled cour tracker. A tracker in the `any` family is native
only when it is the only one enabled, and it is recorded last in a fan-out.

Identity resolution for each adapter is one ladder: a native id, then an id mapped through the
crosswalk, then a title search, then the user-correction picker.

**The crosswalk (`lib/animap/`).** It is built from Fribb's `anime-lists`, trimmed to
`{ anilist_id, mal_id, tmdb_id, tmdb_kind, tmdb_season, episode_offset, type }` and served as
`recipes/anime-map.json`. It is fetched from the CDN and cached in `local:anime_map`, refreshed
daily, not bundled, because its rows are about 300 KB and upstream changes weekly. Two indices are
built at load: `byTmdb` for pages that speak TMDB, and `byAnilist` for dedicated anime sites.
`forward()` and `reverse()` return `resolved | ambiguous | miss` and **never guess**:

- `resolved` gives the target id and local episode. Attack on Titan (TMDB tv 1429) has 8 AniList
  entries. TMDB season 3 splits into two, one at offset 0 and one at offset 12, so S3E15 becomes
  local episode 3 of the second.
- `ambiguous` means more than one candidate shares a TMDB season with no offset to split them.
  The derived write is refused with a warning.
- `miss` means the item is not in the map. The derived tracker is skipped and logged, with no
  warning, because a miss is a normal degrade to native-only.

User corrections to the map (`animap_overrides`, including MAL pins) win over Fribb: precedence is
local override, then Fribb, then miss. The crosswalk's limit is coverage, not math. When it was
first measured, about one in five Fribb entries had both an AniList and a TMDB id, and among those
about 97% resolved mechanically. **Hard rule:** the crosswalk lives in `lib/animap/` and the
adapters, is background-side only, and the shared engine never imports it.

**Fan-out.** The content script sends the full toggled tracker set with each scrobble. The
background records the native tracker through its adapter, then calls `recordDerivedTrackers` to
resolve and record the others (`resolveAcross` reads what each tracker matches, read-only). Each
outcome comes back per tracker, and the badge shows one status per tracker, for example Trakt
recorded and AniList refused for numbering. A derived `miss` or `ambiguous` drops only that tracker.
Enabling a second tracker on an already tracked anime tracks forward from then on, with no
backfill.

**Progress is independent and advance-only.** Each tracker is read before it is written, and its
progress is `max(remote, scraped)`, never lower. Trackers never arbitrate between each other, so one
may be ahead if the user advanced it elsewhere. The one real failure is a *wrong mapping* writing
the wrong episode to a derived tracker. Three guards catch it: refuse-on-ambiguous, the per-tracker
guardrail that refuses `progress > episodes`, and the "Rewatching?" confirm, which applies per
tracker.

**Rating fans out too.** Rating once writes to every enabled and resolved tracker, each in its own
shape. The panel shows the union of rating levels, labelled per tracker. Public comments and
reviews are deferred everywhere.

**Known limitation.** A general site that shows one absolute episode number (not per season)
would need an absolute-to-season step that does not exist. TMSync refuses rather than guesses.

**Rating, notes & exports** are co-located with each tracker, not inlined in the background: Trakt
rating/notes in `lib/trakt/review.ts`, AniList in `lib/anilist/review.ts`, MAL in
`lib/mal/review.ts`, Simkl in `lib/simkl/review.ts`, and Trakt's Letterboxd
CSV export in `lib/trakt/letterboxd.ts`. The background's `rateItem`/`saveNote`/etc. handlers are
thin dispatchers over the `REVIEW` registry. (The `TrackerAdapter` interface itself covers
resolve/record/ratingLevels/watchedState; folding rate/note *writes* into the interface is a future
step best done when a third tracker exists to shape it.)

---

## 6. Session & scrobble machine: `lib/scrobble/`

- **`session.ts`, `SessionManager`** (per frame). The messy real-world glue: the matcher/player
  iframe split, SPA navigation (it patches `history.pushState`/`replaceState`), late metadata
  (watches `<head>` mutations for a late `og:title`), hover-gated player chrome (it can even
  synthesize pointer nudges to make lazy players render their metadata), manual recipes, and
  episode-less URLs (prompts for the episode). It also collects cross-origin iframe origins so the
  popup can offer to grant them.
- **`controller.ts`, `ScrobbleController`** (the actual state machine). Debounces play/pause bursts
  (~800ms), is idempotent (never fires the same action twice), turns a late pause into a stop, and
  `progressTick()` commits the stop the instant progress crosses the threshold, robust against
  players that never fire `ended`.
- **Ownership:** `claimScrobbleOwner` guarantees exactly one scrobbling frame per tab (5-min TTL),
  so an iframe player and the top page don't double-scrobble.

---

## 7. Messaging: `packages/extension/messaging.ts`

One typed `ProtocolMap` via `@webext-core/messaging`, no ad-hoc `postMessage`. It's
the contract for content↔background↔popup/options. Content→background carries `scrobble`,
`publishMedia`, `updateProgress`, `endSession`, resolve/rate/note/correction messages;
background→content carries `recheck` and `scrobbleStatus`; popup/options→background carries status,
connect, search, and register/unregister. All handlers live in `background.ts`.

---

## 8. Storage: `packages/extension/lib/storage.ts`

Every persisted value is a `storage.defineItem`, split into three layers by prefix. The rule that
keeps them consistent: **the export bundle equals the sync payload equals "your own deltas."**
Library content comes from the repo and is never synced or exported. Device-local content never
travels.

| Layer | What | Where | Travels? |
|---|---|---|---|
| **Library** | shared recipes and quick-link templates (PR-contributed) | `local:remote_recipes` cache, plus the bundled seed | no, each device fetches the repo itself |
| **Sync** | your recipes, quick links, corrections, manual picks, badge prefs, and your toggles on library items | `sync:` | yes, the only synced layer |
| **Local** | tokens, resolution and rating caches, `enabled_origins`, crosswalk data | `local:` | no, secret or regenerable |

- **`sync:`** (small, cross-device, user-owned): one `recipe:{id}` key per custom recipe (through
  `recipe-store.ts`), plus `quick_links`, `quick_links_enabled`, `corrections`, `manual_selections`,
  and `badge_prefs`.
- **`local:`** (per-device): `trakt_tokens`, `anilist_tokens`, `mal_tokens`, `simkl_tokens`, the
  resolution caches, `simkl_matches`, `simkl_scrobble_at`, `simkl_held_stops`, rating and note
  mirrors (the tracker is the source of truth), `remote_recipes`, `enabled_origins`, `anime_map`
  and `animap_overrides`, `anilist_corrections`, `mal_corrections`, and `quicklink_slugs`.
- **`session:`** (ephemeral, per tab): `tab_sessions` (the crash-reconcile source of truth),
  `tab_frame_origins`, `tab_status`, `manual_contexts`, `episode_overrides`.

**Merge, at read time:** `effective = library (minus what the user disabled) + user items`. User
data always wins, a library refresh never overwrites it, and a library item removed upstream leaves
a harmless orphan toggle. The `source: "library" | "user"` field on a quick link is the
discriminator.

**Why `storage.sync`.** It is the browser vendor's sync (a Google or Firefox account), not a TMSync
backend, so there is still no backend. Its limits shape the design:
1. **Quota:** 100 KB total, 8 KB per item, 512 items, and write-rate caps. Never store one growing
   array under a single key. Custom recipes are per-item keys. Quick links, corrections, and manual
   picks are still single keys, so cap or LRU any set that can grow.
2. **Best effort.** It works only when the user is signed in to the browser with sync on, so
   export and import is the universal fallback.
3. **Host permissions do not sync**, because they are per device and need a user gesture. Synced
   recipes drive a "these sites are set up on your other device, click to enable here" prompt, and
   `enabled_origins` stays local because it reflects actual grants.
4. **Last write wins**, per item.

**Export and import** serialize the sync layer, and nothing else: no library content, no tokens, no
caches. Import merges into the sync layer with user data winning, and de-duplicates by id. It is the
fix for "my setup is on the PC and I am on the laptop", with or without browser sync.

The background reads all of this fresh on every wake. There is no in-memory background state
(constraint #4).

---

## 9. UI: `packages/extension/lib/ui/`

- **`kit/kit.tsx`**, the shared design system: `tokens(variant)` (light/dark token maps), and
  primitives `Btn`, `IconBtn`, `Switch`, `Stars`, `Icon`, `TraktMark`, `AniListMark`, `MalMark`, `SimklMark` (via `TrackerMark`). Dark is the
  shipped direction.
- **`kit/*View.tsx`**, presentational views (`PopupView`, `OptionsView`, `PickerPanel`,
  `BadgeView`, `QuickLinksView`, …). They take mock-able props and hold no browser APIs, which is
  what lets the **gallery** (`entrypoints/gallery/`) render every surface + state with fake data as
  a live component catalog.
- **`badge.tsx`**, the injected on-page badge, mounted via WXT's `createShadowRootUi` for Shadow
  DOM style isolation. Notable tricks: `keepAboveModals` re-parents the shadow host into an active
  `<dialog>` top-layer so the badge stays clickable over site modals; drag-to-edge docking with FLIP
  animation; a key-shield so page shortcuts don't leak.

---

## 10. Element picker: `lib/picker/`

How a new site gets added without code. `recipe-builder.ts` is pure authoring logic:
`autoDetectFields` (tries og/jsonld/title first, using the real `readField`), `suggestUrlPattern`,
regex/number/title chip builders, `buildRecipe` (assembles + Zod-validates), and `previewDraft`
(runs the *actual* `extract()` for a live preview). `PickerApp.tsx` is the overlay UI, it uses
`@medv/finder` to turn a clicked element into a short, robust CSS selector, and saves the result to
`custom_recipes`, reflecting live into the running content script.

---

## 11. Build, test, distribution

- **WXT** (`packages/extension/wxt.config.ts`): Preact + Tailwind v4. Minimal install permissions
  (`storage, alarms, scripting, identity, activeTab`) + specific host perms (Trakt, AniList, the
  recipe CDN); broad access is `optional_host_permissions` requested per-origin on a gesture. MAL's
  hosts are optional too, requested on Connect. A
  `build:manifestGenerated` hook strips WXT's derived broad host perms and re-expresses them as
  optional. A committed extension `key`/`gecko.id` keeps the extension id, and thus the OAuth
  redirect URI, stable.
- **Multi-browser:** `dev` / `dev:firefox` / `build` / `build:firefox` / `zip*`; outputs under
  `.output/`.
- **Tests:** Vitest (`happy-dom`) for the colocated unit suites (engine, schema, match,
  controller, animap, recipe-builder, clients, …); Playwright for the E2E perf regression
  (`e2e/perf.e2e.ts`). `pnpm test` runs both packages.
- **TS:** strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Biome for lint/format.

---

## 12. Known limitations

- **Picker versus schema ids.** The schema supports an open multi-id `ids` map, but the picker
  detects TMDB ids only and stores them under `ids.tmdb`. Other namespaces are hand-authorable in a
  recipe today. Teaching the picker to detect them needs no schema change and is deferred until there
  is a concrete need.
- **Absolute-numbered sites.** See the note under multi-tracking above.
- **Quick-link, correction, and manual-pick sync keys** are single keys under the sync quota, not
  per-item keys yet.

---

## 13. Where do I look when...

| You want to… | Start here |
|---|---|
| Change how a value is read off a page | `packages/shared/src/extract.ts` |
| Add/adjust a recipe field or transform | `packages/shared/src/schema.ts` + `transforms.ts` |
| Change how a site is matched | `packages/shared/src/match.ts` |
| Touch play/pause/stop timing | `lib/scrobble/controller.ts` |
| Touch iframe/SPA/late-metadata handling | `lib/scrobble/session.ts` |
| Add or change a tracker | `lib/tracker/adapter.ts` + a new `lib/<tracker>/` folder |
| Debug Trakt resolution/scrobble | `lib/trakt/client.ts`, `lib/trakt/auth.ts` |
| Debug AniList / MAL writes | `lib/anilist/client.ts`, `lib/mal/client.ts`, `lib/tracker/cour-plan.ts` |
| Change rating / notes behaviour | `lib/trakt/review.ts`, `lib/anilist/review.ts`, `lib/mal/review.ts` |
| Debug anime double-tracking | `lib/animap/` + `recordDerivedTrackers` in `background.ts` |
| Change the badge / picker / popup UI | `lib/ui/kit/` (+ `entrypoints/gallery/` to preview) |
| Change stored data or add a cache | `lib/storage.ts` |
| Add a message between parts | `packages/extension/messaging.ts` |
