# CLAUDE.md — TMSync

Operating guide for Claude Code on this repo. Read before generating or editing code. These decisions are **settled**; do not relitigate or "improve" them without being asked.

## Project in one paragraph
TMSync is a cross-browser (Chrome + Firefox) WebExtension that passively scrobbles what the user watches on arbitrary streaming sites (including gray-market ones with no API) to the right tracker: **movies and non-anime TV → Trakt**, **anime series → AniList**. It detects the media from the page using **declarative recipes** (data, not code), resolves it against the tracker(s) it routes to, and records progress. **Anime may be multi-tracked to both Trakt and AniList** via a bundled TMDB↔AniList crosswalk (`docs/MULTI-TRACK.md`); everything else stays Trakt-only. Site definitions can be added on the fly via an in-page element picker. See `docs/TMSync-PRD.md` for the "what/why".

> **Direction note (2026-06):** the owner deliberately reversed the original "Trakt only / no anime" scope to add AniList for anime. This is intentional, not drift. AniList lives behind the tracker-adapter seam (see **Tracker adapters**). Where this doc and the old constraints disagree, this doc wins.

> **Direction note (2026-07) — supersedes the 2026-06 "routed, never synced" model:** the owner reversed constraint #1's *never-synced* half to allow **multi-tracking anime to BOTH Trakt and AniList** (Mihon/Aniyomi-style), backed by the Fribb TMDB↔AniList crosswalk — validated against real coverage data, not theory. This also lifts constraint #2's general-site / offset-mapping / is-anime-classifier non-goal. Still **exactly two trackers**; **non-anime stays Trakt-only**; the crosswalk stays **out of `extract()`**. Design + phased build order now live in **`docs/MULTI-TRACK.md`** (which supersedes `docs/ANIME-PLAN.md`).

## Hard constraints (never violate)
1. **Pluggable tracker registry, multi-tracked.** Trackers are a **list you can grow** — currently **Trakt + AniList**, but adding more later is expected (2026-07: the old "exactly two, no third" hardline is **retired**). Each tracker is one implementation behind the adapter seam (see **Tracker adapters**); adding one = a new adapter + a picker toggle + (if it uses a different numbering) an anime-map entry — **without touching the other trackers or the shared `extract()` engine**. An item may be written to **every enabled tracker at once** (multi-track — `docs/MULTI-TRACK.md`); the picker exposes an **independent on/off toggle per tracker** (no "primary tab"). Which enabled tracker is **native** (its numbering matches the page → written directly) vs **derived** (mapped via the crosswalk) is **inferred at scrobble time**, not user-picked. Feasibility is per-item: a tracker that can't resolve an item (e.g. AniList on non-anime) is simply skipped. The old "one item → one tracker, never synced" rule is **retired**.
2. **Multi-track via the anime-map crosswalk — quarantined outside `extract()`.** The Fribb TMDB↔AniList crosswalk resolves an item's identity + episode across the two numbering systems (one **native** tracker written directly, the **other derived** via the crosswalk — best-effort, refuse-on-ambiguous, skip-on-miss). This lifts the old "general-site anime / offset-mapping / is-anime-classifier" non-goal (reversed 2026-07, with coverage data). Hard rule that survives the reversal: **the crosswalk lives in `lib/animap/` + the adapters and NEVER leaks into the shared `extract()` engine.** Anime-map derivation is per-tracker and advance-only; it never lowers remote progress and never silently mis-writes a wrong cour (guardrails: `docs/MULTI-TRACK.md` §9, §12).
3. **No remote code execution.** Never `eval`, `new Function`, inject remote `<script>`, or fetch-and-run JS. Recipes are **data** interpreted by the bundled engine. This is an MV3 + store-policy requirement, not a style choice. The recipe schema must stay expressive enough that no site ever needs a code escape hatch.
4. **Background is a stateless, ephemeral MV3 service worker.** Never keep watch-session state, timers, or accumulated buffers in background memory. The content script owns session state. The background reads everything it needs from `storage` on each wake. Use `alarms` if scheduling is ever required.
5. **No broad host permissions at install.** Use `optional_host_permissions: ["*://*/*"]` and request per-origin on a user gesture, then `chrome.scripting.registerContentScripts`. Never put `<all_urls>` in `host_permissions`. `activeTab` is insufficient (per-click, non-persistent).
6. **Privacy split.** Resolution + scrobbling are client-side. Watch data goes only to the user's own tracker accounts (Trakt and/or AniList) — and each item to just the one it's routed to. Any current/future backend receives only anonymous recipe data — never watch history.
7. **No backend in v1.** Recipes are a versioned JSON list fetched from the repo/CDN, contributed by PR. Do not scaffold a server unless explicitly asked (that is Phase 2).
8. **Validate untrusted input.** Every recipe is parsed through the Zod schema before use. A recipe failing validation is discarded, never partially applied.

## Stack (use exactly these)
- **WXT** + **TypeScript** (strict). File-based entrypoints; multi-browser build (Chrome + Firefox).
- **Injected content UI:** Preact (lightweight; content scripts ship on every page). Render inside Shadow DOM via WXT's `createShadowRootUi`. Tailwind allowed only if scoped into the shadow root.
- **Options page:** React is fine here (not injected, weight irrelevant). Any UI kit / design system is welcome (shadcn, Radix, etc.).
- **Messaging:** `@webext-core/messaging` for typed content↔background↔options messages. No ad-hoc `postMessage` plumbing.
- **Storage:** WXT storage API. `local` for caches (recipe list, resolution cache, per-(site,show) corrections, OAuth tokens). `sync` for small user prefs.
- **Element picker selectors:** `@medv/finder` to generate short, robust, unique selectors. Do not hand-roll selector heuristics.
- **Validation:** Zod (recipe schema + any external payloads).
- **Trakt:** OAuth via `browser.identity.launchWebAuthFlow` (or device-code flow). A thin typed `fetch` client — no heavy SDK. Cache search/resolve results.
- **AniList:** OAuth via `browser.identity.launchWebAuthFlow`. **Originally planned as implicit grant, but AniList removed it** (its authorize endpoint returns `unsupported_grant_type` for `response_type=token`, verified 2026-06), so TMSync uses the **Authorization Code grant** — get a `code` on the redirect, exchange it at `/oauth/token` with the bundled client secret. This still needs **no backend** (constraint #7 holds — the secret is bundled exactly like Trakt's); the only change from the old plan is a bundled secret instead of none. ~1-year token validity. A thin typed GraphQL `fetch` client (one POST endpoint) — no SDK. Reads use `Media` (`id`, `idMal`, `title`, `synonyms`, `episodes`, `relations`); writes use `SaveMediaListEntry(mediaId, progress, status)`. Read the user's `mediaListOptions { scoreFormat }` to render scores. Cache resolutions. AniList has **no real-time scrobble endpoint** — see **Tracker adapters**.
- **Monorepo:** pnpm workspaces.

## Repo layout
```
/
├─ packages/
│  ├─ extension/      # WXT app: entrypoints/, content/, background/, options/, engine/
│  ├─ shared/         # recipe schema (Zod) + types + pure helpers (no DOM, no browser APIs)
│  └─ server/         # Phase 2 only — do not create until asked
├─ recipes/index.json # ONE tracker-agnostic recipe + quick-link list (Phase 1 source of truth,
│                     #   PR-contributed). Trakt and AniList recipes coexist; each carries its own
│                     #   `tracker` field and the engine routes per-recipe — no per-tracker files.
├─ docs/              # design notes: TMSync-PRD, ARCHITECTURE, MULTI-TRACK, STORAGE-SYNC
├─ CONTRIBUTING.md
├─ README.md
└─ CLAUDE.md
```

## Recipe schema (source of truth lives in `packages/shared`)
Declarative only. A `Field` says *where* a value is and *how to clean it* — never *how to compute it* with code.

```ts
import { z } from "zod";

export const SCHEMA_VERSION = 2; // v2 adds `tracker`; v1 recipes have no `tracker` → default "trakt" (back-compat)

const Transform = z.enum(["trim", "lowercase", "uppercase", "toInt", "collapseSpaces"]);

const Field = z.object({
  source: z.enum(["url", "meta", "jsonld", "dom", "title"]),
  // dom: CSS selector; meta: property/name (e.g. "og:title"); jsonld: dotted path (e.g. "partOfTVSeason.seasonNumber")
  selector: z.string().optional(),
  attr: z.string().optional(),          // dom only: read an attribute instead of textContent
  regex: z.string().optional(),         // applied to the raw string
  group: z.number().int().optional(),   // capture group index (default 1)
  transforms: z.array(Transform).optional(),
});

const Recipe = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),      // client ignores recipes with a newer schemaVersion than it supports
  name: z.string(),                     // human-readable site name
  match: z.object({
    urlPattern: z.string(),             // regex tested against location.href
    domFingerprint: z.string().optional(), // a selector that must exist; primary clone-resilient key
    hostnames: z.array(z.string()).optional(), // hints only, not the primary match
  }),
  mediaType: z.enum(["auto", "movie", "show"]).default("auto"),
  tracker: z.enum(["trakt", "anilist"]).default("trakt"), // which adapter records this site. anilist ⇒ anime
                                                          // series only; the engine routes by this field.
  video: z.object({
    selector: z.string().default("video"),
    frame: z.enum(["auto", "top", "iframe"]).default("auto"),
    watchedThreshold: z.number().min(0).max(1).default(0.8), // per-site "treat as finished here" point for sites with long credits. For Trakt it only governs WHEN to fire stop — Trakt owns the actual watched decision (its own 80% on /scrobble/stop). For AniList there is no scrobble API, so this threshold IS the watched decision (crossing it ⇒ SaveMediaListEntry progress=N).
  }).default({}),
  extract: z.object({
    title: Field,
    year: Field.optional(),             // helps movie disambiguation
    season: Field.optional(),           // shows
    episode: Field.optional(),          // shows
  }),
});

export type Recipe = z.infer<typeof Recipe>;
export const RecipeSchema = Recipe;
```

Engine contract: a single pure-ish `extract(recipe, { document, url }): ParsedMedia` in the bundle reads fields per `source`, applies `regex`/`group`/`transforms`, and returns `{ mediaType, title, year?, season?, episode? }`. It contains zero recipe-supplied executable code.

## Runtime flow
1. Content script matches enabled recipes by `domFingerprint` + `urlPattern`.
2. On match, find the `<video>` (respect `video.frame`; remember the player may be in a cross-origin iframe while metadata is in the top frame — coordinate via messaging).
3. Run `extract()` → `ParsedMedia`. Show the badge.
4. **Route by `recipeTrackers(recipe)`** → pick the adapter(s); for anime this may be **both** Trakt and AniList (multi-track — the session fans out; `docs/MULTI-TRACK.md`). The engine and `extract()` are tracker-agnostic; everything tracker-specific (including the anime-map crosswalk) lives behind the adapter (see **Tracker adapters**).
   - **Trakt:** resolve identity once via background → Trakt search (returns trakt/imdb/tmdb IDs; cache it). For shows pass season+episode **as scraped** (Western TV is already seasoned; do **not** build absolute-numbering translation).
   - **AniList:** resolve title → AniList `Media` id once via background GraphQL (cache it). v1 targets dedicated anime sites where the scraped episode number already matches the AniList entry, so **pass episode as scraped** — no offset mapping yet.
5. **Record progress via the adapter.** Trakt uses the **real-time scrobble** state machine below. AniList has no scrobble API — it instead writes `SaveMediaListEntry` once `watchedThreshold` is crossed (see **Tracker adapters**). The rest of this section is the **Trakt** path:
   **Real-time scrobble** (start/pause/stop, not a custom threshold loop):
   - video `play` → `POST /scrobble/start` (current progress %) → sets "Currently Watching" on the profile.
   - genuine `pause` → `POST /scrobble/pause` → saves position, feeds Continue Watching.
   - `ended` → `POST /scrobble/stop` (~100%).
   - leaving before `ended` (tab close / SPA nav / video element removed) → also `POST /scrobble/stop` with last known progress.
   - **Trakt owns the watched decision:** on `stop`, progress ≥ 80% → added to history; < 80% → kept as paused/Continue Watching. Do not implement a parallel watched-threshold. If a stricter cutoff is ever wanted, send `pause` (not `stop`) below it to avoid duplicate scrobbles.
6. Corrections: user picks the right entry (Trakt search result, or AniList `Media`) → store keyed by `(siteId, rawTitle)` → reused on future matches → optionally offered as a contribution.

### Scrobble rules (avoid API abuse + lost stops)
- One `start` per session; coalesce/debounce rapid `play`/`pause` bursts (seeking, ad breaks, keyframe stepping). Scrobbling every raw event is the classic mistake.
- Throttle-persist latest progress to `storage` every few seconds. If the page dies before a clean `stop`, the (stateless) background sends a reconciling `stop` with the last persisted progress — this is the main reason session state lives in the content script + storage, not background memory.
- Idempotent per session: a re-fired event or resumed playback must never create a duplicate scrobble.

## Tracker adapters
One seam, two implementations, selected per recipe by `recipeTrackers()` — which, for anime, may return **both** (multi-track; a watch session fans out to each resolved adapter — `docs/MULTI-TRACK.md`). The shared engine (`extract()`, video detection, session/state, badge) is **tracker-agnostic** and must stay that way. Everything tracker-specific — auth, identity resolution, progress recording, and the episode mapping (the `lib/animap/` crosswalk, native-vs-derived) — lives behind the adapter interface. Adding/enabling a tracker must not touch the other's path.

Sketch (final shape lives in code, not here):
```ts
interface TrackerAdapter {
  resolve(media: ParsedMedia): Promise<TrackedItem | null>;        // title (+season/episode) → tracker id
  recordProgress(item: TrackedItem, progress: number, phase: "play"|"pause"|"stop"): Promise<void>;
  // rating + review — the existing Trakt rating/comment feature lives behind this seam too:
  ratingLevels(item: TrackedItem): RatingLevel[];                  // which levels this tracker rates → UI affordances
  rate(item: TrackedItem, level: RatingLevel, score: number): Promise<void>;
  setNote(item: TrackedItem, text: string): Promise<void>;        // private note (Trakt VIP note / AniList MediaList.notes)
  postPublic?(item: TrackedItem, body: string): Promise<void>;    // optional, DEFERRED — Trakt public comment / AniList public Review
}
```

**The two paradigms are genuinely different — do not force them into one code path:**

| | **Trakt** | **AniList** |
|---|---|---|
| Progress API | real-time scrobble `start`/`pause`/`stop` | none — just `SaveMediaListEntry(mediaId, progress, status)` |
| Watched decision | **Trakt owns it** (≥80% on stop) | **we own it** — crossing `watchedThreshold` ⇒ write `progress=N`, `status: CURRENT`→`COMPLETED` |
| Auth | OAuth (web auth / device code) | **auth code grant** — bundled secret, no backend (implicit grant was removed by AniList) |
| Identity | Trakt search → trakt/imdb/tmdb ids | GraphQL `Media` search → AniList id (`idMal` bridges to MAL-keyed data later) |
| Episode numbering | pass season/episode as scraped | v1: pass as scraped (dedicated sites only) |

**AniList recording rules (the analogue of the Trakt scrobble rules):**
- No `start`/`pause` chatter — AniList has nothing to receive it. Only **one write per episode**, when `watchedThreshold` is crossed. Debounce so seeking/replaying never double-writes.
- **Read-before-write — the entry is the source of truth.** Before each write, fetch the viewer's `MediaList { status progress repeat }` and compute the transition from it (NOT a local counter — a local counter can lower remote progress if the user advanced the entry on the AniList site). **Never lower `progress`.**
- **Status state machine (we own it).** not-on-list / `PLANNING` / `PAUSED` / `DROPPED` + a watch → `CURRENT`, `progress = max(remote, ep)`. Final episode → `COMPLETED`. We never *set* PLANNING/PAUSED/DROPPED ourselves.
- **A `COMPLETED` cour is never silently mutated.** Re-watching any episode of a completed cour does **not** write — it surfaces a **"Rewatching?" confirmation** in the badge first (upfront, on any episode, not just the last). On confirm → status `REPEATING`, tracking resumes; the final episode re-`COMPLETED`s it and **increments `repeat`**. This is the one place AniList is interactive (the rest is passive, like Trakt) because auto-incrementing repeats on a stray replay would be wrong.
- **Rating prompt fires on completion only** (you rate a cour once at the end, not per episode).
- Respect AniList's modest per-minute rate limit; these writes are infrequent by design, so this is mostly about not retrying in a tight loop.
- **Guardrail — fail visibly, never silently corrupt.** Before writing, if the scraped `progress` exceeds the resolved entry's `Media.episodes`, **refuse the write and surface a "this site's numbering doesn't match AniList" warning** instead. This catches the classic v1 mis-authoring (an `anilist` recipe pointed at a TMDB/absolute-numbered site → episode 50 written to a 12-ep cour, silently completing it). It won't catch every mismatch (e.g. ep 6 written to the wrong same-length cour), but it turns the worst, most common failure from silent corruption into a loud, fixable error.

**Rating & reviews are adapter-driven — the levels differ, so the UI must not assume a fixed set.** TMSync already has the Trakt rating/comment feature; it moves behind the seam, and AniList implements its own shape:

| | **Trakt** | **AniList** |
|---|---|---|
| Rate at | show / season / **episode** (multiple levels) | **entry = cour only** (no per-episode, no franchise-wide score) |
| Score scale | 1–10 | per user's `scoreFormat` (`POINT_100`/`POINT_10[_DECIMAL]`/`POINT_5`/`POINT_3`) |
| Private text | VIP note | `MediaList.notes` (per cour, via `SaveMediaListEntry`) |
| Public text | comment (≥5 words) | `Review` — separate `SaveReview` entity, public, ~2200-char min |

- AniList score + private `notes` both write through `SaveMediaListEntry`, both attach to the **cour entry** — there is no episode-level user score and no object above the entries to rate.
- `ratingLevels(item)` lets the shared UI render only the affordances a tracker supports: Trakt shows show/season/episode stars; an AniList anime entry shows a single "rate this cour."
- **v1 = score + private note.** AniList's public `Review` (heavyweight, long minimum) and Trakt public comments map to the optional `postPublic` and are **deferred**.

**Episode mapping is a NON-GOAL (see constraint #2), not a roadmap item.** Anime support = dedicated anime sites whose numbering matches the AniList entry; episode is passed as scraped and the numbering guardrail above is the safety net. The hard absolute↔entry offset arithmetic (TMDB/general sites, the `Media.relations` walk, a cross-walk database, the is-anime classifier) is deliberately **not** built — it only serves the cross-tracker-sync use case TMSync rejects. If it is ever revisited, it is a private concern of the AniList adapter and must never appear in the shared engine. Background kept for reference only (not an endorsement to build): `Fribb/anime-lists`, `Anime-Lists/anime-lists` (`anime-list-master.xml`), `manami-project/anime-offline-database`, `MALSync/MAL-Sync-Backend`.

## Conventions
- TypeScript strict; no `any` at module boundaries. Share types from `packages/shared`.
- Keep `packages/shared` free of DOM and browser APIs (pure, testable, server-reusable later).
- Background handlers are stateless functions; persist via storage helpers.
- Recipes prefer `url`/`meta`/`jsonld` over `dom`; the picker should auto-detect page metadata before asking the user to click.
- Errors degrade quietly: a failed scrape shows "couldn't read this page," never throws into the host page.
- **No em/en dashes in generated output** (UI copy, docs, code comments, commit messages, PR text). Use commas, periods, or parentheses instead. This applies to anything written into this repo. (Existing prose in this file predates the rule; do not mass-rewrite it, just follow the rule going forward.)
- **Build after every change.** Run `pnpm build` after editing the extension so type/build errors surface; `pnpm dev:edge` auto-rebuilds while running. Prefer verifying with `./node_modules/.bin/tsc` directly over wrapped typecheck commands.

## UI & visual design (settled — `packages/extension/lib/ui`)
The look and these rules are **settled**; don't relitigate spacing/colour/structure or invent new patterns without being asked. The user cares a lot about **consistency** — uniformity across surfaces is the bar. When adding UI, reuse the kit and match the rules below.

- **Stack:** Tailwind v4 (tokens + base in `lib/ui/theme.css`, wired via `@tailwindcss/vite`). Brand accent is **Trakt red** (`bg-trakt` / `text-trakt`). A shared kit in `lib/ui/kit/` holds the tokens + primitives (`tokens()`, `Btn`, `IconBtn`, `Switch`, `Stars`, `Icon`, `TraktMark`, `AniListMark`) and the presentational views (`PopupView`, `PickerPanel`, `BadgeView`, `QuickLinksView`, `OptionsView`). Real entrypoints stay thin and feed these props.
- **Theme: dark is the chosen direction** (`tokens("dark")`). A light token set still exists and must keep working, but dark is what ships.
- **Gallery harness:** `entrypoints/gallery/` renders every surface + state with mock data and a light/dark switch — the prototyping/review tool. Keep it updated when you add UI states. View via `pnpm dev` → `chrome-extension://<id>/gallery.html`.
- **Consistency rules (keep uniform across popup / picker / badge / quicklinks / options):**
  - Icon actions (close, minimize, reorder, edit, delete) use the **borderless `IconBtn`** (hover state, no ring). Never mix bordered and borderless icon buttons.
  - **Destructive** actions are a **trash `IconBtn` (`danger`)**, identical everywhere (recipes, corrections, quick links).
  - Text buttons: `primary` (filled red) = the main action; `ghost` = secondary (Refresh, Add, Disable, Copy JSON); `danger` (ghost-rose) = bulk-destructive (Clear all).
  - **Red underline is for genuine inline text links only** (e.g. "contribute here"). Never style a button as red underlined text.
  - All interactive controls get `cursor: pointer` (restored in the theme base layer; Tailwind v4 preflight defaults buttons to `default`).
  - In any header show **either the logo mark or the wordmark — not both**.
- **Account section is a provider list** — now **two rows**: Trakt (`TraktMark` + "Trakt" + status + Connect/Disconnect) and AniList (its mark + "AniList" + status + Connect/Disconnect). Each row NAMES the provider so "Connect" is never "connect to what?". The two are independent connections, not a sync pair — an item is routed to one tracker, never mirrored to both (constraint #1). Reuse the existing provider-row component for both; don't invent a second pattern. Section is labelled "Account".
- **Injected UI + Tailwind (Shadow DOM):** badge / picker / quicklinks render inside a Shadow DOM. Tailwind v4 emits its theme custom properties on `:root`, which do **not** reach a shadow root — so `var(--color-*)` (i.e. every colour utility) is unresolved there. Wiring Tailwind into the injected surfaces requires making the theme vars available inside the shadow scope (mirror them onto `:host`) — solve and document this when wiring those three. (Popup + options are normal pages and need none of this.)

## Testing
- **Vitest** for `shared` (schema, `extract` against saved HTML snapshots — keep fixtures in `packages/extension/test/fixtures/`).
- **Playwright** for extension E2E (load the built extension, drive a fixture page, assert a scrobble call).
- Add a recipe-snapshot harness early: given saved DOM + a recipe, assert the parsed media. Most regressions are recipe rot; this catches them.

## Drift guards — do NOT do these
- Adding a tracker IS allowed (the registry is pluggable — 2026-07). But it must go **behind the adapter seam** (a `TrackerAdapter`) + a picker toggle; never special-cased in the shared engine. (Letterboxd stays a CSV *export target*, not a tracker.)
- Do not put the anime-map crosswalk (or any episode-mapping / is-anime logic) into the shared `extract()` engine. It lives in `lib/animap/` + the adapters. This is the ONE rule that survives the 2026-07 multi-track reversal.
- Do not resurrect a "primary tracker" tab/selector in the picker — trackers are **independent toggles**; native-vs-derived is inferred at runtime.
- Do not multi-track **non-anime** — movies/Western TV are Trakt-only (they don't exist on AniList). Multi-track is anime-only.
- Do not silently mis-write a derived tracker: **refuse-on-ambiguous** + per-tracker `progress > episodes` guardrail; each tracker is advance-only and never lowers remote progress (`docs/MULTI-TRACK.md` §9, §12).
- Keep the recipe library as ONE tracker-agnostic file (`recipes/index.json`): every recipe carries its own `tracker` field and the engine routes per-recipe. Do NOT reintroduce per-tracker recipe files/directories (the old `recipes/trakt/` + `recipes/anime/` split was retired 2026-07 — it baked tracker into the layout and doesn't scale as trackers are added).
- Do not give AniList a fake scrobble loop — it has no scrobble API; one `SaveMediaListEntry` write per episode at threshold.
- Do not create `packages/server` or any hosted DB/voting system in v1.
- Do not store session state, timers, or buffers in the background service worker.
- Do not request `<all_urls>` or put host permissions in the install manifest.
- Do not let recipes carry or run JavaScript; no `eval`/`new Function`/remote scripts.
- Do not send watch history anywhere except the user's own tracker accounts (Trakt / AniList).
- Keep the **injected** content UI (badge / picker / quicklinks) lean and Shadow-DOM-friendly — it ships on every granted page, so mind bundle weight and style isolation (Tailwind + headless primitives are fine; avoid a heavy CSS-in-JS runtime in the content script). The **options page** has no weight budget — use whatever UI kit/design system you like there.
