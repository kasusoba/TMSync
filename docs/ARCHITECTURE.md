# TMSync Architecture

A plain-English tour of how the code works, subsystem by subsystem. Read it when you need to answer
"where does X happen?" or "what talks to what?". The hard rules live in
[`CLAUDE.md`](../CLAUDE.md). Recipe details are in [`RECIPES.md`](./RECIPES.md), and per-tracker API
facts are in [`TRACKERS.md`](./TRACKERS.md).

TMSync scrobbles movies and non-anime TV to Trakt, WeTrakr, and/or Simkl, and anime to AniList and/or
MyAnimeList (and to Trakt, WeTrakr, and Simkl too), all at once if the user wants. It works on arbitrary
streaming sites, including ones with no API. List sync (section 7) can also bring the
lists of all connected trackers in sync. It exists because tools like MAL-Sync cover only anime,
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
│   connectedTrackers → inferNativeTracker → TrackerAdapter(s)                       │
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
5. **Route.** The background decides which adapter(s) get this item from `recipeTrackers()`,
   kept to the trackers the user connected (`connectedTrackers()`). A recipe can name several
   trackers, and the item fans out to all of them. Every tracker takes movies: an anime movie is a
   one-episode entry on AniList and MAL.
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

`lib/trackers/adapter.ts` defines the contract; `lib/trackers/index.ts` is the routing single source
of truth (`getAdapter`, `connectedTrackers`, `inferNativeTracker`, `speaksPage`). Four
implementations behind it.
`TRACKER_INFO` holds each tracker's metadata (label, numbering **family**; see below). It also says what each
tracker rates (`levels` or the whole `entry`) and what note it keeps (`public`, `private`,
`none`); the rating panel reads those, not tracker names.

| | **Trakt** (`lib/trackers/trakt/`) | **WeTrakr** (`lib/trackers/wetrakr/`) | **AniList** (`lib/trackers/anilist/`) | **MyAnimeList** (`lib/trackers/mal/`) | **Simkl** (`lib/trackers/simkl/`) |
|---|---|---|---|---|---|
| Progress | real-time scrobble `start`/`pause`/`stop` | real-time scrobble; a mismatched echoed episode cancels the session | none, one `SaveMediaListEntry` per episode at threshold | none, one `PATCH my_list_status` per episode at threshold | real-time scrobble, one call per 20 s |
| Watched decision | Trakt owns it (≥80% on stop) | WeTrakr owns it (≥80% on stop) | *we* own it (crossing `WATCHED_THRESHOLD`, 80%) | *we* own it (same planner) | Simkl owns it (≥80% on stop) |
| Auth | OAuth authorization-code, refresh-token rotation | code + PKCE (S256), no secret, 7-day token, rotating refresh, logout on disconnect | OAuth authorization-code, ~1-year token, no refresh | authorization code + PKCE, no secret, refresh on 401 / near expiry | AUTH V2 code + PKCE (S256), no secret, 7-day token, refresh + revoke |
| Identity | `/search` → trakt/imdb/tmdb ids | `/media/external` by page id, else `/search` | GraphQL `Media` search → AniList id | MAL id, AniList `idMal`, else MAL search | none: each write sends ids + title + year; the match is cached from the reply |
| Resolvable ids | tmdb, imdb, tvdb | tmdb, imdb, tvdb | anilist, mal | mal | all (only when alone) |
| Host access | install manifest | optional, asked on Connect (API and site) | install manifest | optional, asked on Connect | none (CORS) |

**Why they're deliberately different code paths:** AniList has no concept of "currently watching",
so faking a scrobble loop for it would be wrong. It reads the viewer's existing list entry *before
every write* (the entry is the source of truth), never lowers `progress`, and treats a `COMPLETED`
season as sacred: re-watching prompts a "Rewatching?" confirmation in the badge before it touches
anything. That decision logic is pure, tested, and shared by AniList and MAL in
`lib/trackers/cour-plan.ts` (`planCourWrite`); each adapter maps the plan to its own fields.

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

**Each tracker stands alone.** "Enabled" means toggled on for the recipe AND connected
(`connectedTrackers`). A tracker the user never connected is never called and never anchors the
others, so a user with only MAL does not depend on Trakt being up (or existing). It gets a quiet
"not connected" row in the badge. When none of a recipe's trackers is connected, all of them count,
so the badge can still show a match before Connect. Because of this, the native tracker can be one
that does not speak the page's numbering (a cour tracker on a TMDB page when Trakt is not
connected). `speaksPage` catches that case: the native tracker then goes through the crosswalk like
a derived one, so it gets the exact cour and its own episode. A crosswalk miss falls back to the
page as scraped (the numbering guardrail still applies), and an ambiguous row is refused.

**Anime movies.** A movie is a one-episode entry on the cour side. As native, AniList and MAL search
only movie entries on a movie page (and only series on a series page), and a watch counts
episode 1, which completes it (`courEpisode`). Derived, the crosswalk maps a TMDB movie the same
way.

Identity resolution for each adapter is one ladder: a native id, then an id mapped through the
crosswalk, then a title search, then the user-correction picker.

**The crosswalk (`lib/trackers/animap/`).** It is built from Fribb's `anime-lists`, trimmed to
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
about 97% resolved mechanically. **Hard rule:** the crosswalk lives in `lib/trackers/animap/` and the
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
rating/notes in `lib/trackers/trakt/review.ts`, AniList in `lib/trackers/anilist/review.ts`, MAL in
`lib/trackers/mal/review.ts`, Simkl in `lib/trackers/simkl/review.ts`, and Trakt's Letterboxd
CSV export in `lib/portability/letterboxd.ts`.

**Background services.** Each tracker also has a `service.ts`: its account (status, connect,
disconnect), its rating and note calls, a cour tracker's fix-match pins, and any alarm or
listener it needs on each worker wake. Features only one tracker has register their own message
handlers there too (Trakt: the fix-match search, trakt.tv slug ids, the Letterboxd export). The
registry is `lib/trackers/service.ts`. The background's account, `rateItem`/`saveNote`/etc., and
fix-match handlers are thin dispatchers over it, so the background never names a tracker for
these. Manual mode (a site with no readable title) searches through the optional `search` on each
service, so it works with any connected tracker that can search (Trakt, AniList, MAL; Simkl has
none because of its quota). The pick carries the entry's ids, and a tracker that needs more to lock
the match keeps its own (`pinPick`: Trakt saves a correction). (The `TrackerAdapter` interface itself covers
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

## 7. List sync: `lib/sync/`

List sync makes the user's lists match across every connected tracker: watched episodes, list
status, and ratings. The user previews a plan in Options, then applies it. Automatic sync
(optional) runs the same jobs once a day and applies only the additions. It runs in the background,
and nothing of it touches `extract()` or the scrobble path.

**Four steps.**

1. **Read.** Each tracker's service has `readList(kinds, saved, timed)`, which returns its whole list as
   normalized `ListEntry` values in one of three shapes: `movie` (watched or not), `seasons` (a
   set of watched episodes per season: Trakt, WeTrakr, Simkl shows), and `cour` (a count plus a status:
   AniList, MAL, Simkl anime). A `movie` or `seasons` entry can carry a status too: the Trakt
   watchlist (plan to watch) and dropped shows, a WeTrakr tracking list, a Simkl list. The readers live in `lib/trackers/<tracker>/list.ts`, each a pure
   normalizer (Zod per item, a bad item is dropped) plus a fetch in its `client.ts`. A tracker with
   a change check reuses its saved list (see "Change checks").
2. **Plan.** `planSync` (`plan/`, pure; `plan/index.ts` names each file's part) groups entries that are the same thing, by id only, never
   by title. Movies and non-anime TV move between Trakt, WeTrakr, and Simkl by tmdb, imdb, or tvdb. Anime is
   planned per cour. A seasoned list reaches a cour through the crosswalk, with the user's fix-match
   pins folded in (`withOverrides`). A crosswalk miss or ambiguity is a skip, reported, never a
   guess. The result is a `SyncPlan`: per-item writes (`SyncWrite`, which describe intent, not API
   calls), skips with reasons, conflicts, and notices.
3. **Preview.** The Options "List sync" pane (`lib/ui/kit/list-sync/`) shows the plan as a table
   with one column per tracker, and tabs for removals, conflicts, skips, and items the user keeps
   out. The text of each write (`describeWrite`) is pure, in `lib/sync/describe.ts`.
4. **Apply.** Each service has `applyList`, a chunk size and a `run(writes)` that turns writes
   into that tracker's API calls (`lib/trackers/<tracker>/apply.ts`).

**Merge rules.**

- **Union by default.** Each tracker gets what the others have. Nothing is removed, and progress
  never goes down.
- **A main list per kind (optional).** For movies, TV, or anime, one tracker can be the main list.
  Only it is a source; the others copy it, and a list entry it does not have is removed from them.
  Trakt watch history is never removed, since deleting plays cannot be undone. A copy that is
  further than the main list keeps its progress, and the plan says so as a notice. Trakt and
  WeTrakr cannot be a main list (`canBeMain`): their lists are watch history, which sync never
  removes, so a copy could never be made to match them. A saved Trakt or WeTrakr main list reads
  as none.
- **Remembered removals (always on).** In a union, an entry or a rating removed from one list
  since the last sync is removed from the others instead of added back (see "The base").
  There is no switch: the removal is always in the preview first, an automatic run holds it for
  the user, and an item the user wants on one list only goes on the ignore list. Trakt watch
  history is still never removed; the plan says so as a notice.
- **Kinds per tracker.** The user picks which kinds each tracker takes part in. A kind that is off
  is off both ways: not read as a source and not written as a target.
- **Status.** When the progress finishes an entry, it is completed. Otherwise the entries that
  hold a status give it. When they hold different ones, the plan lists a conflict and writes no
  status until the user picks: dates are a poor guide, since an import or a sync write moves them.
  The entries still follow the episodes (a planned entry with progress is watching). The Changes
  tab says how many conflicts wait. A completed entry is never moved.
- **Status on movies and TV** (`plan/status.ts`). The same rule, plus the watches: a planned show
  with watches is being watched, and a show watched after it was paused or dropped is being
  watched again. Each tracker gets only the statuses it can hold: Trakt plan to watch (movies,
  shows) and dropped (shows), WeTrakr and Simkl plan to watch, watching, paused, and dropped
  (movies: plan to watch and dropped). A tracker leaves a status it holds when the status moves on
  (off the Trakt watchlist once watched). Completed is never written: it comes from the watches.
  For anime, a seasoned show status counts only when the crosswalk maps the show to exactly one
  cour (or the item is a movie), since one show status cannot name one of several cours.
- **Remembered misses** (`misses.ts`). A write a tracker answers "not found" for (the item, or the
  episodes it sent) is remembered per tracker and item. The planner leaves it out and lists it as
  a skip. This stops a write that can never land from failing on every apply: Simkl numbers TV
  episodes in TVDB order, Trakt and WeTrakr in TMDB order. A miss expires after 30 days, and
  connecting the account again forgets it.
- **Ratings** fill empty ratings only. Scores are compared on the target's own scale, so rounding
  (AniList 85 to MAL 9 and back) never loops. Two different ratings are a conflict.
- **Start and finish days** (AniList `startedAt` and `completedAt`, MAL `start_date` and
  `finish_date`) fill empty days only, on AniList and MAL (Simkl keeps none). A copy gets the first
  start day of the sources, and the last finish day once the copy is finished. A day the copy has
  is never changed, and a completed entry still gets an empty day filled (a day is not a move).
  Only full dates count: a MAL date with no day is left alone.
- **Picks.** In a conflict the user can pick the value every tracker gets (`withPicks`), one at a
  time or for every conflict shown at once ("Trakt's value"). A picked status still follows the
  episodes. A picked rating replaces the ratings that differ.
- **Private and adult** AniList entries are skipped unless the user includes them.
- **Convergence.** Applying a plan and planning again must give no writes. The planner tests check
  this for every case.

**Jobs, not long messages.** A preview and an apply each run as a job whose state lives in storage
(`local:list_sync_job`, `local:list_sync_apply`). The start message returns at once, the job saves
each step with a beat every 10 seconds, and the options page watches the storage item. Closing the
page does not stop a job. A job whose beat is older than 30 seconds was stopped by the browser, and
the pane says so. Bump `SYNC_JOB_VERSION` or `APPLY_JOB_VERSION` when a saved shape changes: a job
from an older build is dropped on read, not rendered. The preview job is `preview.ts`, the apply job
`apply.ts`, and what they share (the saves, the beat, the start lock) is `job.ts`. The lock makes
the check "no job runs" and the first save one step, so an alarm and a click at the same time start
one job, not two. A running job keeps its beat timer, a retry sleep, and the lists it reads in
memory. That is the one scoped exception to constraint #4 (CLAUDE.md): a job is one bounded run, and
a worker stopped mid-job loses only time, since the read caches and the writes already taken stay
and the next preview plans what is left.

**Apply.** Trackers run side by side. Each writes in chunks of its own size and spaces its own
requests. The counts are saved after each chunk, and AniList and MAL also report each entry as it is
done. Stop ends the run after the chunk in flight, and what was written stays: every write is safe on
its own. A tracker that answers "too many requests", or loses its connection, stops for the run.
Nothing retries in a loop.

**No resume from a saved place.** To finish a stopped apply, the user previews again and applies
that plan. The planner diffs against what each tracker has now, so written items drop out, and a
history write is never sent twice (on Trakt each one is a new play), not even for a chunk cut off
when the worker stopped. For the same reason a preview is applied once, and only while it is less
than 10 minutes old (`applyBlock`).

**Read before write (AniList, MAL).** Scrobbling can change an entry between the preview and the
apply. So each write is merged with a fresh read of the entry (`merge.ts`, pure): progress is
`max(fresh, planned)`, a completed entry is never moved, a status goes in only if the entry still has
the status the preview saw, and a rating fills an empty one unless the user picked it.

**Dates.** A backfilled watch on Trakt or Simkl gets the date the source list was last watched
(`watchedAt`), so a large first sync does not put hundreds of watches on one day. It is never the
last change of the entry: a rating or a watchlist add years after the watch would date the play by
it. Trakt, WeTrakr, and Simkl give the last watch. AniList and MAL give the finish day of a finished entry,
else only the last change, which can be later than the watch but never earlier. Every episode of
one backfill gets the same date. When the date is unknown, Trakt uses the air date and Simkl uses
the time of the write.

**Change checks (`list-cache.ts`).** Trakt (`/sync/last_activities`) and Simkl (`/sync/activities`)
can say whether a list changed. Each saves the list it read with the stamps from BEFORE the read
(`local:list_sync_cache_<tracker>`), so a change during the read is seen next time. A part whose
stamp did not move is reused, not read. Trakt uses the `all` stamp, per part (shows, movies): its
docs do not say which field a removal moves, so it may read when only a comment changed, but it
never misses a change. Simkl checks each type (`tv_shows`, `anime`, `movies`): unmoved = no read, a
null stamp = never used, so empty. Moved with `removed_from_list` unmoved = a `date_from` delta laid
over the saved list by Simkl id. Moved with a removal = that type in full, since a delta never
reports removals. AniList and MAL have no change check: their reads are small, have no quota, and a
"newest update" query misses a deleted entry. A saved list is dropped when its account connects or
disconnects. The tracker cards say "No changes since the last read" or "Read only what changed".

**Automatic sync (`auto.ts`, optional, off by default).** One switch in the pane. While it is on, a
`browser.alarms` alarm (`tmsync-list-sync`, daily) runs the preview job, then an apply job of the
ADDITIONS only (`additionsOnly`): watched episodes and movies, new entries, progress up, a higher
rewatch count, empty rating fills, and the status progress brings (watching, or completed at the
last episode). A watching or planned AniList or MAL entry that is at its last episode already also
goes in as completed: the tracker did not know the episode count when the last episode was
recorded. Removals (of entries and ratings), other status changes without progress (a paused or
dropped entry, any Simkl status), a new entry with a disputed status, and every conflict wait for
the user. The toolbar badge counts the held items the user has not seen; opening the pane marks
them seen. The daily plan is too old to apply by the time the user sees it, so the pane shows a
"Review held changes" button in place of Apply. It previews again, and the new preview opens on
the held items only (a "Held by daily sync" filter the user can turn off). Apply still writes the
whole new plan. A tab's own badge text is cleared with
`null`, not `""`, or it would hide the count. A run within 20 hours of the last one is skipped,
since alarms can fire again on a browser start. A running manual job skips the run, and the
automatic jobs block manual ones the same way. A preview the user made and has not applied yet
(with writes, under 10 minutes old) skips the run too, so the run never replaces a preview, and its
picks, while the user reads it. On a timer, Simkl is left out when its change check
fails: Simkl suspends apps that read without it. The result is `local:list_sync_auto`.

**The base (`base.ts`, `base-store.ts`).** For remembered removals, the planner needs each list as
it was after the last sync. The base keeps only each entry's id keys and whether it was rated
(and Trakt's rated seasons), so it stays small. A preview saves the lists it read as pending
(`local:list_sync_base_next`). They become the base (`local:list_sync_base`) when there is nothing
to write, or when the apply of that preview ends, with the writes it took laid over
(`afterWrites`). An item it did not finish (a write failed, was left out because the entry changed,
was never sent, or was held back by an automatic run) keeps its entries from the old base on every
list (`keepOpen`). Read as it is now, a removal that did not go through would look like "never
there" and be added back, and a write that did not happen would look like a removal. So one write
that keeps failing holds back only its own item, never the rest of the base. With no base yet (the first sync, or after a settings change), a union only adds. It
is dropped when the settings that give it meaning change (`settingsSig`: kinds, main lists,
private, adult) and per tracker when an account connects or disconnects. Each account change is
stamped (`local:list_sync_account_at`). A list read before the stamp belongs to the old account, so
a preview that ran across the change drops that read, the pending base never commits it, and its
plan cannot be applied. The planner reads an item
as removed from a list only when that list had it at the base and no entry of it now shares any id
with it, so a crosswalk change is never a removal. If a list that has it now did not have it at the
base (it was added since), the add wins and the item is added back. Clearing a rating is an
`unrate` write. Trakt makes an entry from a rating alone, so the base marks an entry with nothing
watched as only ratings (`o`). When that entry goes, the user removed the rating, not the item: it
is an `unrate` on the others, never a removal.

**Removed marks.** A removal can leave a copy sync never deletes (Trakt watch history, or a Simkl
show that holds other cours). Without more, the next base would have the item only in that copy,
and the sync after it would add the item back from there. So the plan lists the lists that lose
the item (`SyncPlan.removed`), and the next base keeps a REMOVED mark for it on each (`x`). A mark
counts as "had it at the base", so the item stays removed there, but not as a list that holds it,
so it never blocks a removal. A list that was not read this run (a failed read, an expired sign-in)
also counts as a kept copy when its base has the item: its old base stays, and without marks the
next run would read its copy and add the item back. An anime's mark names the cour by its AniList and MAL ids only,
never the TMDB show, which names every cour. The plan says "history kept" only when the removal
is new, not on every later sync. A mark goes when the user adds the item to that list again (the
add wins), and when no list keeps a copy any more (the plan stops carrying it).

**Stored choices.** `listSyncSettings` in `storage.ts` reads and writes one `ListSyncSettings`
value over three items. Kinds, main lists, private, and adult are small user prefs and sync
(`sync:list_sync_settings`). The ignore list stays on the device (`local:list_sync_ignore`): it can
grow past the 8 KB a synced item may hold. Automatic sync is per device too
(`local:list_sync_auto_on`): two browsers running the daily sync side by side would each send the
same Trakt plays. All of it but automatic sync goes into the backup, and an import keeps the
importing device's own automatic sync. Picks (`local:list_sync_picks`) stay on the device.

**Limits.** Before the first sync there is no base, so a union brings back what the user
removed on one tracker, because another still has it. An item an apply did not finish stays at
the old base until an apply finishes it: an add to it that went through is not in the base yet, so
if it is then removed on another list, the add wins. Un-watched episodes are never carried over (that would lower
progress). The ignore list does not follow the user to another browser (the backup carries it).

---

## 8. Messaging: `packages/extension/messaging.ts`

One typed `ProtocolMap` via `@webext-core/messaging`, no ad-hoc `postMessage`. It's
the contract for content↔background↔popup/options. Content→background carries `scrobble`,
`publishMedia`, `updateProgress`, `endSession`, resolve/rate/note/correction messages;
background→content carries `recheck` and `scrobbleStatus`; popup/options→background carries status,
connect, search, register/unregister, and the list sync starts (`listSyncStart`,
`listSyncApply`). Account messages take the tracker as data
(`getTrackerStatus`, `connectTracker`, `disconnectTracker`), so a new tracker adds no message. All
handlers live in `background.ts`.

---

## 9. Storage: `packages/extension/lib/storage.ts`

Every persisted value is a `storage.defineItem`, split into three layers by prefix. The rule that
keeps them consistent: **the export bundle equals the sync payload equals "your own deltas."**
Library content comes from the repo and is never synced or exported. Device-local content never
travels.

| Layer | What | Where | Travels? |
|---|---|---|---|
| **Library** | shared recipes and quick-link templates (PR-contributed) | `local:remote_recipes` cache, plus the bundled seed | no, each device fetches the repo itself |
| **Sync** | your recipes, quick links, corrections, manual picks, badge prefs, list sync choices, and your toggles on library items | `sync:` | yes, the only synced layer |
| **Local** | tokens, resolution and rating caches, `enabled_origins`, crosswalk data | `local:` | no, secret or regenerable |

- **`sync:`** (small, cross-device, user-owned): one `recipe:{id}` key per custom recipe (through
  `recipes/store.ts`), plus `quick_links`, `quick_links_enabled`, `corrections`, `manual_selections`,
  `badge_prefs`, and `list_sync_settings` (without the ignore list and automatic sync, which
  are per device).
- **`local:`** (per-device): `trakt_tokens`, `anilist_tokens`, `mal_tokens`, `simkl_tokens`,
  `wetrakr_tokens`, the resolution caches, `wetrakr_corrections`, `wetrakr_ids_cache`,
  `simkl_matches`, `simkl_scrobble_at`, `simkl_held_stops`, rating and note
  mirrors (the tracker is the source of truth), `remote_recipes`, `enabled_origins`, `anime_map`
  and `animap_overrides`, `anilist_corrections`, `mal_corrections`, `quicklink_slugs`, and the
  list sync state (`list_sync_ignore`, `list_sync_auto_on`, `list_sync_job`, `list_sync_apply`, `list_sync_cancel_at`, `list_sync_picks`,
  `list_sync_cache_<tracker>`, `list_sync_base`, `list_sync_base_next`, `list_sync_auto`,
  `list_sync_auto_seen`).
- **Tokens are encrypted at rest** (`lib/secret.ts`). An AES-GCM key, made non-extractable, lives
  in the extension's IndexedDB, and the `*_tokens` items hold only ciphertext (`secretItem` in
  `lib/storage.ts`). A copy of `storage.local` alone holds no usable token. Code that runs as the
  extension can still decrypt, so this is defense in depth. If the key is lost (the browser's
  site data was cleared), the tokens read as null and the user connects again. The background
  seals any plain token on each wake. Only extension pages and the background can read tokens: a
  content script would reach the host page's IndexedDB.
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

## 10. UI: `packages/extension/lib/ui/`

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

## 11. Element picker: `lib/picker/`

How a new site gets added without code. `recipe-builder.ts` is pure authoring logic:
`autoDetectFields` (tries og/jsonld/title first, using the real `readField`), `suggestUrlPattern`,
regex/number/title chip builders, `buildRecipe` (assembles + Zod-validates), and `previewDraft`
(runs the *actual* `extract()` for a live preview). `PickerApp.tsx` is the overlay UI, it uses
`@medv/finder` to turn a clicked element into a short, robust CSS selector, and saves the result to
`custom_recipes`, reflecting live into the running content script.

---

## 12. Build, test, distribution

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

## 13. Known limitations

- **Picker versus schema ids.** The schema supports an open multi-id `ids` map, but the picker
  detects TMDB ids only and stores them under `ids.tmdb`. Other namespaces are hand-authorable in a
  recipe today. Teaching the picker to detect them needs no schema change and is deferred until there
  is a concrete need.
- **Absolute-numbered sites.** See the note under multi-tracking above.
- **Quick-link, correction, and manual-pick sync keys** are single keys under the sync quota, not
  per-item keys yet.

---

## 14. Where do I look when...

| You want to… | Start here |
|---|---|
| Change how a value is read off a page | `packages/shared/src/extract.ts` |
| Add/adjust a recipe field or transform | `packages/shared/src/schema.ts` + `transforms.ts` |
| Change how a site is matched | `packages/shared/src/match.ts` |
| Touch play/pause/stop timing | `lib/scrobble/controller.ts` |
| Touch iframe/SPA/late-metadata handling | `lib/scrobble/session.ts` |
| Add or change a tracker | `lib/trackers/adapter.ts`, `lib/trackers/service.ts` + a new `lib/trackers/<tracker>/` folder |
| Debug Trakt resolution/scrobble | `lib/trackers/trakt/client.ts`, `lib/trackers/trakt/auth.ts` |
| Debug AniList / MAL writes | `lib/trackers/anilist/client.ts`, `lib/trackers/mal/client.ts`, `lib/trackers/cour-plan.ts` |
| Change rating / notes behaviour | `lib/trackers/trakt/review.ts`, `lib/trackers/anilist/review.ts`, `lib/trackers/mal/review.ts` |
| Debug anime double-tracking | `lib/trackers/animap/` + `recordDerivedTrackers` in `background.ts` |
| Change the badge / picker / popup UI | `lib/ui/kit/` (+ `entrypoints/gallery/` to preview) |
| Change list sync (plan, apply, the pane) | `lib/sync/` + `lib/trackers/<tracker>/list.ts` and `apply.ts` + `lib/ui/kit/list-sync/` |
| Change stored data or add a cache | `lib/storage.ts` |
| Add a message between parts | `packages/extension/messaging.ts` |
