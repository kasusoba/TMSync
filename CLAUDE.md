# CLAUDE.md — TMSync

Operating guide for Claude Code on this repo. Read before generating or editing code. These decisions are **settled**; do not relitigate or "improve" them without being asked.

## Project in one paragraph
TMSync is a cross-browser (Chrome + Firefox) WebExtension that passively scrobbles **movies and TV shows to Trakt** while the user watches on arbitrary streaming sites, including gray-market ones with no API. It detects the media from the page using **declarative recipes** (data, not code), resolves it against Trakt, and marks it watched at a progress threshold. Site definitions can be added on the fly via an in-page element picker. See `TMSync-PRD.md` for the "what/why".

## Hard constraints (never violate)
1. **Trakt only.** No other trackers. No cross-tracker ID/episode mapping. A thin tracker-adapter interface may exist as a seam, but only Trakt is implemented.
2. **No anime.** Out of scope (MAL-Sync covers it). Do not add anime sites, AniList/MAL logic, or absolute↔season mapping.
3. **No remote code execution.** Never `eval`, `new Function`, inject remote `<script>`, or fetch-and-run JS. Recipes are **data** interpreted by the bundled engine. This is an MV3 + store-policy requirement, not a style choice. The recipe schema must stay expressive enough that no site ever needs a code escape hatch.
4. **Background is a stateless, ephemeral MV3 service worker.** Never keep watch-session state, timers, or accumulated buffers in background memory. The content script owns session state. The background reads everything it needs from `storage` on each wake. Use `alarms` if scheduling is ever required.
5. **No broad host permissions at install.** Use `optional_host_permissions: ["*://*/*"]` and request per-origin on a user gesture, then `chrome.scripting.registerContentScripts`. Never put `<all_urls>` in `host_permissions`. `activeTab` is insufficient (per-click, non-persistent).
6. **Privacy split.** Resolution + scrobbling are client-side. Watch data goes only to the user's Trakt account. Any current/future backend receives only anonymous recipe data — never watch history.
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
- **Monorepo:** pnpm workspaces.

## Repo layout
```
/
├─ packages/
│  ├─ extension/      # WXT app: entrypoints/, content/, background/, options/, engine/
│  ├─ shared/         # recipe schema (Zod) + types + pure helpers (no DOM, no browser APIs)
│  └─ server/         # Phase 2 only — do not create until asked
├─ recipes/           # versioned JSON recipe list (Phase 1 source of truth, PR-contributed)
├─ TMSync-PRD.md
└─ CLAUDE.md
```

## Recipe schema (source of truth lives in `packages/shared`)
Declarative only. A `Field` says *where* a value is and *how to clean it* — never *how to compute it* with code.

```ts
import { z } from "zod";

export const SCHEMA_VERSION = 1;

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
  video: z.object({
    selector: z.string().default("video"),
    frame: z.enum(["auto", "top", "iframe"]).default("auto"),
    watchedThreshold: z.number().min(0).max(1).default(0.8), // per-site "treat as finished here" point for firing stop on sites with long credits; NOT the watched decision (Trakt applies its own 80% on /scrobble/stop)
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
4. Resolve identity once via background → Trakt search (returns trakt/imdb/tmdb IDs; cache it). For shows pass season+episode **as scraped** (Western TV is already seasoned; do **not** build absolute-numbering translation).
5. **Real-time scrobble** (start/pause/stop, not a custom threshold loop):
   - video `play` → `POST /scrobble/start` (current progress %) → sets "Currently Watching" on the profile.
   - genuine `pause` → `POST /scrobble/pause` → saves position, feeds Continue Watching.
   - `ended` → `POST /scrobble/stop` (~100%).
   - leaving before `ended` (tab close / SPA nav / video element removed) → also `POST /scrobble/stop` with last known progress.
   - **Trakt owns the watched decision:** on `stop`, progress ≥ 80% → added to history; < 80% → kept as paused/Continue Watching. Do not implement a parallel watched-threshold. If a stricter cutoff is ever wanted, send `pause` (not `stop`) below it to avoid duplicate scrobbles.
6. Corrections: user picks the right Trakt entry → store keyed by `(siteId, rawTitle)` → reused on future matches → optionally offered as a contribution.

### Scrobble rules (avoid API abuse + lost stops)
- One `start` per session; coalesce/debounce rapid `play`/`pause` bursts (seeking, ad breaks, keyframe stepping). Scrobbling every raw event is the classic mistake.
- Throttle-persist latest progress to `storage` every few seconds. If the page dies before a clean `stop`, the (stateless) background sends a reconciling `stop` with the last persisted progress — this is the main reason session state lives in the content script + storage, not background memory.
- Idempotent per session: a re-fired event or resumed playback must never create a duplicate scrobble.

## Conventions
- TypeScript strict; no `any` at module boundaries. Share types from `packages/shared`.
- Keep `packages/shared` free of DOM and browser APIs (pure, testable, server-reusable later).
- Background handlers are stateless functions; persist via storage helpers.
- Recipes prefer `url`/`meta`/`jsonld` over `dom`; the picker should auto-detect page metadata before asking the user to click.
- Errors degrade quietly: a failed scrape shows "couldn't read this page," never throws into the host page.

## UI & visual design (settled — `packages/extension/lib/ui`)
The look and these rules are **settled**; don't relitigate spacing/colour/structure or invent new patterns without being asked. The user cares a lot about **consistency** — uniformity across surfaces is the bar. When adding UI, reuse the kit and match the rules below.

- **Stack:** Tailwind v4 (tokens + base in `lib/ui/theme.css`, wired via `@tailwindcss/vite`). Brand accent is **Trakt red** (`bg-trakt` / `text-trakt`). A shared kit in `lib/ui/proto/` holds the tokens + primitives (`tokens()`, `Btn`, `IconBtn`, `Switch`, `Stars`, `Icon`, `TraktMark`) and the presentational views (`PopupView`, `PickerPanel`, `BadgeView`, `QuickLinksView`, `OptionsView`). Real entrypoints stay thin and feed these props. (Folder is named `proto/` for historical reasons — it's the real shared UI.)
- **Theme: dark is the chosen direction** (`tokens("dark")`). A light token set still exists and must keep working, but dark is what ships.
- **Gallery harness:** `entrypoints/gallery/` renders every surface + state with mock data and a light/dark switch — the prototyping/review tool. Keep it updated when you add UI states. View via `pnpm dev` → `chrome-extension://<id>/gallery.html`.
- **Consistency rules (keep uniform across popup / picker / badge / quicklinks / options):**
  - Icon actions (close, minimize, reorder, edit, delete) use the **borderless `IconBtn`** (hover state, no ring). Never mix bordered and borderless icon buttons.
  - **Destructive** actions are a **trash `IconBtn` (`danger`)**, identical everywhere (recipes, corrections, quick links).
  - Text buttons: `primary` (filled red) = the main action; `ghost` = secondary (Refresh, Add, Disable, Copy JSON); `danger` (ghost-rose) = bulk-destructive (Clear all).
  - **Red underline is for genuine inline text links only** (e.g. "contribute here"). Never style a button as red underlined text.
  - All interactive controls get `cursor: pointer` (restored in the theme base layer; Tailwind v4 preflight defaults buttons to `default`).
  - In any header show **either the logo mark or the wordmark — not both**.
- **Account section is a provider row** (`TraktMark` + "Trakt" + status + Connect/Disconnect). It NAMES the provider so "Connect" is never "connect to what?". One row today; the layout scales to a list if another tracker is ever added — but TMSync still scrobbles to a **single** account (no multi-tracker sync; constraint #1). Section is labelled "Account", not "Trakt".
- **Injected UI + Tailwind (Shadow DOM):** badge / picker / quicklinks render inside a Shadow DOM. Tailwind v4 emits its theme custom properties on `:root`, which do **not** reach a shadow root — so `var(--color-*)` (i.e. every colour utility) is unresolved there. Wiring Tailwind into the injected surfaces requires making the theme vars available inside the shadow scope (mirror them onto `:host`) — solve and document this when wiring those three. (Popup + options are normal pages and need none of this.)

## Testing
- **Vitest** for `shared` (schema, `extract` against saved HTML snapshots — keep fixtures in `packages/extension/test/fixtures/`).
- **Playwright** for extension E2E (load the built extension, drive a fixture page, assert a scrobble call).
- Add a recipe-snapshot harness early: given saved DOM + a recipe, assert the parsed media. Most regressions are recipe rot; this catches them.

## Drift guards — do NOT do these
- Do not add Simkl, Letterboxd, TMDB, or any non-Trakt tracker.
- Do not add anime handling or absolute↔season episode mapping.
- Do not create `packages/server` or any hosted DB/voting system in v1.
- Do not store session state, timers, or buffers in the background service worker.
- Do not request `<all_urls>` or put host permissions in the install manifest.
- Do not let recipes carry or run JavaScript; no `eval`/`new Function`/remote scripts.
- Do not send watch history anywhere except the user's Trakt account.
- Keep the **injected** content UI (badge / picker / quicklinks) lean and Shadow-DOM-friendly — it ships on every granted page, so mind bundle weight and style isolation (Tailwind + headless primitives are fine; avoid a heavy CSS-in-JS runtime in the content script). The **options page** has no weight budget — use whatever UI kit/design system you like there.
