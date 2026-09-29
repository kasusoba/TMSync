# CLAUDE.md — TMSync

Operating guide for Claude Code on this repo. Read before generating or editing code. These decisions are **settled**; do not relitigate or "improve" them without being asked.

## Project in one paragraph
TMSync is a cross-browser (Chrome + Firefox) WebExtension that passively scrobbles what the user watches on arbitrary streaming sites (including gray-market ones with no API) to the right tracker: **movies and non-anime TV → Trakt and/or Simkl**, **anime series → AniList and/or MyAnimeList (MAL)** (and Trakt and Simkl too). It detects the media from the page using **declarative recipes** (data, not code), resolves it against the tracker(s) it routes to, and records progress. **Anime may be multi-tracked to Trakt, AniList, MAL, and Simkl at once** via a TMDB↔AniList crosswalk (with MAL ids); Simkl takes the page's own numbering and never uses the crosswalk. Non-anime goes only to Trakt and Simkl. Site definitions can be added on the fly via an in-page element picker. `docs/ARCHITECTURE.md` explains how it works, `docs/RECIPES.md` covers recipes, and `docs/TRACKERS.md` covers each tracker's API.

## Hard constraints (never violate)
1. **Pluggable tracker registry, multi-tracked.** Trackers are a **list you can grow**, currently **Trakt + AniList + MyAnimeList + Simkl**. Each tracker is one implementation behind the adapter seam (see **Tracker adapters**); adding one = a new adapter + a picker toggle + (if it uses a different numbering) an anime-map entry, **without touching the other trackers or the shared `extract()` engine** (checklist: `docs/TRACKERS.md`). An item may be written to **every enabled tracker at once** (multi-track, `docs/ARCHITECTURE.md`); the picker exposes an **independent on/off toggle per tracker** (no "primary tab"). Which enabled tracker is **native** (its numbering matches the page → written directly) vs **derived** (mapped via the crosswalk) is **inferred at scrobble time**, not user-picked. Feasibility is per-item: a tracker that can't resolve an item (e.g. AniList on non-anime) is simply skipped.
2. **Anime multi-track via the anime-map crosswalk, quarantined outside `extract()`.** The Fribb TMDB↔AniList crosswalk resolves an item's identity + episode across the two numbering systems (one **native** tracker written directly, the others **derived** via the crosswalk: best-effort, refuse-on-ambiguous, skip-on-miss). The hard rule: **the crosswalk lives in `lib/trackers/animap/` + the adapters and NEVER leaks into the shared `extract()` engine.** Derivation is per-tracker and advance-only; it never lowers remote progress and never silently mis-writes a wrong cour (guardrails: `docs/ARCHITECTURE.md`, "Multi-tracking").
3. **No remote code execution.** Never `eval`, `new Function`, inject remote `<script>`, or fetch-and-run JS. Recipes are **data** interpreted by the bundled engine. This is an MV3 + store-policy requirement, not a style choice. The recipe schema must stay expressive enough that no site ever needs a code escape hatch.
4. **Background is a stateless, ephemeral MV3 service worker.** Never keep watch-session state, timers, or accumulated buffers in background memory. The content script owns session state. The background reads everything it needs from `storage` on each wake. Use `alarms` if scheduling is ever required. **One scoped exception: list sync jobs** (`lib/sync/job.ts`, the preview and apply runs). A job is one bounded run that saves its state to storage after each step, so it may hold a liveness beat timer, a retry sleep, and the lists it is reading in memory while it runs. A worker stopped mid-job loses only time: the saved job shows it stopped, the read caches and the writes already taken stay, and the next preview plans what is left. Nothing else gets this exception, and nothing a job holds in memory may be needed after it ends.
5. **No broad host permissions at install.** Use `optional_host_permissions: ["*://*/*"]` and request per-origin on a user gesture, then `chrome.scripting.registerContentScripts`. Never put `<all_urls>` in `host_permissions`. `activeTab` is insufficient (per-click, non-persistent).
6. **Privacy split.** Resolution + scrobbling are client-side. Watch data goes only to the user's own tracker accounts (Trakt, AniList, MAL, Simkl), and each item only to the trackers it's routed to. Any current/future backend receives only anonymous recipe data, never watch history.
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
- **AniList:** OAuth via `browser.identity.launchWebAuthFlow`, **Authorization Code grant** (AniList has no implicit grant): get a `code` on the redirect, exchange it at `/oauth/token` with the bundled client secret. That needs **no backend** (constraint #7 holds; the secret is bundled exactly like Trakt's). A thin typed GraphQL `fetch` client (one POST endpoint), no SDK. Reads use `Media` (`id`, `idMal`, `title`, `synonyms`, `episodes`, `relations`); writes use `SaveMediaListEntry(mediaId, progress, status)`. Read the user's `mediaListOptions { scoreFormat }` to render scores. Cache resolutions. AniList has **no real-time scrobble endpoint**; see **Tracker adapters**.
- **MyAnimeList:** OAuth authorization code + PKCE via `launchWebAuthFlow`. App type "other": no client secret, no backend (constraint #7). PKCE is `plain` only. Access tokens expire, so `lib/trackers/mal/auth.ts` refreshes on 401 or near expiry and clears the connection when refresh fails. A thin typed REST `fetch` client (`lib/trackers/mal/client.ts`), no SDK. MAL sends no CORS headers, so `myanimelist.net` + `api.myanimelist.net` are **optional** host permissions, requested on Connect (never in the install manifest). Resolution: a MAL id directly, an AniList id through AniList's `idMal` (1:1), else MAL title search (`pickBest`).
- **Simkl:** AUTH V2 authorization code + PKCE (S256) via `launchWebAuthFlow`. Registered as "Mobile, desktop & browser apps": no client secret, no backend (constraint #7). Thin typed REST `fetch` client (`lib/trackers/simkl/`), no SDK. Every request carries `client_id`, `app-name`, `app-version` query params. api.simkl.com answers CORS, so no host permission. Full API notes for every tracker: `docs/TRACKERS.md`.
- **Monorepo:** pnpm workspaces.

## Repo layout
```
/
├─ packages/
│  ├─ extension/      # WXT app: entrypoints/, content/, background/, options/, engine/
│  ├─ shared/         # recipe schema (Zod) + types + pure helpers (no DOM, no browser APIs)
│  └─ server/         # Phase 2 only — do not create until asked
├─ recipes/index.json # ONE tracker-agnostic recipe + quick-link list (source of truth,
│                     #   PR-contributed). Recipes for every tracker coexist; each names its own
│                     #   `trackers` and the engine routes per-recipe. No per-tracker files.
├─ docs/              # ARCHITECTURE, RECIPES, TRACKERS, RELEASING
├─ CONTRIBUTING.md
├─ README.md
└─ CLAUDE.md
```

## Recipe schema
The source of truth is `packages/shared/src/schema.ts` (Zod). The author's reference is `docs/RECIPES.md`. Do not copy the schema into other docs. The rules:
- **Declarative only.** A `Field` says *where* a value is (`source`: `url`, `meta`, `jsonld`, `dom`, `title`) and *how to clean it* (`regex`, `group`, `transforms`), never *how to compute it* with code.
- `match.urlPattern` is the PATH only. `match.hostnames` is the host scope and the origins we request permission for. `match.domFingerprint` is a selector that must exist (the clone-resilient key).
- A recipe names its trackers in `trackers`. Read them through `recipeTrackers(recipe)`, never `recipe.trackers` directly. The legacy single `tracker` field defaults to `"trakt"`.
- The "finished here" point is the engine constant `WATCHED_THRESHOLD` (0.8, in `lib/trackers/types.ts`), never recipe data: a low value from a recipe would mark part-watched episodes as seen. For Trakt and Simkl it only governs WHEN stop fires (they own the watched decision, their own 80% on stop). For AniList and MAL there is no scrobble API, so this threshold IS the watched decision. Rule of thumb: a recipe field describes the SITE (where the title, episode, and video are); tracking behavior stays in the engine.
- Every recipe is parsed through the Zod schema before use. Clients ignore recipes with a newer `schemaVersion` than they support. `docs/RECIPES.md` says when a change needs a bump.

Engine contract: a single pure-ish `extract(recipe, { document, url }): ParsedMedia` in the bundle reads fields per `source`, applies `regex`/`group`/`transforms`, and returns `{ mediaType, title, year?, season?, episode?, ids? }`. It contains zero recipe-supplied executable code.

## Runtime flow
1. Content script matches enabled recipes by `domFingerprint` + `urlPattern`.
2. On match, find the `<video>` (respect `video.frame`; remember the player may be in a cross-origin iframe while metadata is in the top frame — coordinate via messaging).
3. Run `extract()` → `ParsedMedia`. Show the badge.
4. **Route by `recipeTrackers(recipe)`** → pick the adapter(s); for anime this may be **several** of Trakt, AniList, MAL, and Simkl (multi-track: the watch fans out; `docs/ARCHITECTURE.md`). The engine and `extract()` are tracker-agnostic; everything tracker-specific (including the anime-map crosswalk) lives behind the adapter (see **Tracker adapters**).
   - **Trakt:** resolve identity once via background → Trakt search (returns trakt/imdb/tmdb IDs; cache it). For shows pass season+episode **as scraped** (Western TV is already seasoned; do **not** build absolute-numbering translation).
   - **AniList / MAL (native):** resolve the page's own id, else the title, once via the background (cache it), and **pass the episode as scraped**: a dedicated anime site already numbers by cour.
   - **Derived trackers:** the other family goes through the `lib/trackers/animap/` crosswalk (seasoned ↔ cour); AniList and MAL bridge by id (`idMal`); Simkl takes the page's numbering as is.
5. **Record progress via the adapter.** Trakt and Simkl use the **real-time scrobble** state machine below. AniList and MAL have no scrobble API: they write the list entry once `WATCHED_THRESHOLD` is crossed (see **Tracker adapters**). The rest of this section is the **Trakt** path:
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
One seam, one implementation per tracker (Trakt, AniList, MAL, Simkl), selected per recipe by `recipeTrackers()`, which, for anime, may return **several** (multi-track; a watch fans out to each resolved adapter). The shared engine (`extract()`, video detection, session/state, badge) is **tracker-agnostic** and must stay that way. Everything tracker-specific lives behind the adapter interface: auth, identity resolution, progress recording, and the episode mapping (the `lib/trackers/animap/` crosswalk, native-vs-derived). Adding/enabling a tracker must not touch the other's path.

Sketch (final shape lives in code, not here):
```ts
interface TrackerAdapter {
  resolve(media: ParsedMedia): Promise<TrackedItem | null>;        // title (+season/episode) → tracker id
  recordProgress(item: TrackedItem, progress: number, phase: "play"|"pause"|"stop"): Promise<void>;
  // rating + review — the existing Trakt rating/comment feature lives behind this seam too:
  ratingLevels(item: TrackedItem): RatingLevel[];                  // which levels this tracker rates → UI affordances
  rate(item: TrackedItem, level: RatingLevel, score: number): Promise<void>;
  setNote(item: TrackedItem, text: string): Promise<void>;        // the tracker's note (AniList MediaList.notes, MAL comments, Trakt comment)
  postPublic?(item: TrackedItem, body: string): Promise<void>;    // optional, DEFERRED: AniList public Review, Trakt public comment
}
```

**The two paradigms are genuinely different, so do not force them into one code path.** Trakt and Simkl are the scrobble paradigm (real-time `start`/`pause`/`stop`, and the tracker owns the watched decision at 80% on stop). AniList and MAL are the cour/list paradigm (one list write per episode at `WATCHED_THRESHOLD`, and we own the watched decision) and share one pure planner (`lib/trackers/cour-plan.ts`). The side-by-side comparison is in `docs/ARCHITECTURE.md` section 5, and each tracker's API facts are in `docs/TRACKERS.md`.

**Simkl specifics:** it is native only when it is the only enabled tracker (it can take any page), and it is recorded last in a fan-out. Its daily quota is per user and shared with the user's other Simkl apps (500 requests on a free account), so it never polls, never searches, and returns `null` for `watchedState`. A start/pause inside the 20 s lock is dropped; a stop waits for the lock so the watch is never lost.

**MAL recording follows the AniList rules below** (read-before-write, never lower progress, "Rewatching?" confirm, `ep > num_episodes` guardrail). MAL answers 403 for request bursts ("DoS detected"); surface it and never retry in a loop.

**AniList recording rules (the analogue of the Trakt scrobble rules):**
- No `start`/`pause` chatter — AniList has nothing to receive it. Only **one write per episode**, when `WATCHED_THRESHOLD` is crossed. Debounce so seeking/replaying never double-writes.
- **Read-before-write — the entry is the source of truth.** Before each write, fetch the viewer's `MediaList { status progress repeat }` and compute the transition from it (NOT a local counter — a local counter can lower remote progress if the user advanced the entry on the AniList site). **Never lower `progress`.**
- **Status state machine (we own it).** not-on-list / `PLANNING` / `PAUSED` / `DROPPED` + a watch → `CURRENT`, `progress = max(remote, ep)`. Final episode → `COMPLETED`. We never *set* PLANNING/PAUSED/DROPPED ourselves.
- **A `COMPLETED` cour is never silently mutated.** Re-watching any episode of a completed cour does **not** write. It surfaces a **"Rewatching?" confirmation** in the badge first (upfront, on any episode, not just the last). On confirm → status `REPEATING`, tracking resumes; the final episode re-`COMPLETED`s it and **increments `repeat`**. A confirm before the episode passes its threshold (the prompt shows before play) starts the rewatch at the episode before it, so the episode counts only at its own stop (`planRewatchConfirm`). This is the one place AniList is interactive (the rest is passive, like Trakt) because auto-incrementing repeats on a stray replay would be wrong.
- **Rating prompt fires on completion only** (you rate a cour once at the end, not per episode).
- Respect AniList's modest per-minute rate limit; these writes are infrequent by design, so this is mostly about not retrying in a tight loop.
- **Guardrail — fail visibly, never silently corrupt.** Before writing, if the scraped `progress` exceeds the resolved entry's `Media.episodes`, **refuse the write and surface a "this site's numbering doesn't match AniList" warning** instead. This catches the classic v1 mis-authoring (an `anilist` recipe pointed at a TMDB/absolute-numbered site → episode 50 written to a 12-ep cour, silently completing it). It won't catch every mismatch (e.g. ep 6 written to the wrong same-length cour), but it turns the worst, most common failure from silent corruption into a loud, fixable error.

**Rating & reviews are adapter-driven, and the levels differ, so the UI must not assume a fixed set.** Trakt rates at show, season, or episode. AniList, MAL, and Simkl rate only the entry (the cour, or the whole movie or show). The comparison of scales and text fields is in `docs/TRACKERS.md`. The rating panel reads each tracker's `TRACKER_INFO.rates` (`levels` / `entry`) and `.note` (`public` / `private` / `none`), never the tracker name or its numbering family.

- AniList score + private `notes` both write through `SaveMediaListEntry`, both attach to the **cour entry**. There is no episode-level user score and no object above the entries to rate.
- `ratingLevels(item)` lets the shared UI render only the affordances a tracker supports: Trakt shows show/season/episode stars; an AniList anime entry shows a single "rate this cour."
- **v1 = score + private note.** AniList's public `Review` (heavyweight, long minimum) and Trakt public comments map to the optional `postPublic` and are **deferred**.

**Episode mapping lives in the crosswalk, never in the engine (constraint #2).** A TMDB/general site reaches the cour trackers through the Fribb crosswalk in `lib/trackers/animap/` (refuse-on-ambiguous, skip-on-miss, advance-only), and a dedicated anime site passes its episode as scraped. The numbering guardrail above stays the safety net on every cour write. None of this may appear in `extract()` or the shared engine. Other mapping sources, for reference only: `Anime-Lists/anime-lists` (`anime-list-master.xml`), `manami-project/anime-offline-database`, `MALSync/MAL-Sync-Backend`.

## Conventions
- TypeScript strict; no `any` at module boundaries. Share types from `packages/shared`.
- Keep `packages/shared` free of DOM and browser APIs (pure, testable, server-reusable later).
- Background handlers are stateless functions; persist via storage helpers.
- Recipes prefer `url`/`meta`/`jsonld` over `dom`; the picker should auto-detect page metadata before asking the user to click.
- Errors degrade quietly: a failed scrape shows "couldn't read this page," never throws into the host page.
- **No em/en dashes in user-facing text** (UI copy, docs, release notes, store listings, PR text). Use commas, periods, or parentheses instead. This covers internal text too (code comments, commit messages). (Existing prose in this file predates the rule; do not mass-rewrite it, just follow the rule going forward.)
- **Build after every change.** Run `pnpm build` after editing the extension so type/build errors surface; `pnpm dev:edge` auto-rebuilds while running. Prefer verifying with `./node_modules/.bin/tsc` directly over wrapped typecheck commands.

## Shipping work (settled)
Never commit to `main`. Every change reaches `main` through a branch and a PR, so the
release notes generate themselves from the merged PRs instead of being written by hand.
The whole sequence, from a finished change to a published release:

1. **Branch.** `git checkout -b <type>/<slug>` off an up-to-date `main`. Type is the same
   word the commit uses: `feat`, `fix`, `docs`, `chore`, `refactor`.
2. **Commit.** The existing message conventions apply (Simplified Technical English, WHY in
   the body). Run `pnpm lint`, `tsc --noEmit`, `pnpm test`, and `pnpm build` first. Commit
   freely on the branch. The PR is squash-merged, so the branch history does not need to be
   tidy. The detailed commits stay on the PR page.
3. **PR.** `git push -u origin <branch>` then `gh pr create`. **The PR title becomes both the
   commit on `main` and a line in the release notes**, so write it for a user: what changed
   for them, in plain words, no type prefix and no scope. The body carries the detail and
   becomes the commit body, so say WHY there.
4. **Merge** when the owner asks: `gh pr merge --squash --delete-branch`, then
   `git checkout main && git pull`. **Always squash-merge** (settled): one PR is one commit
   on `main`, and GitHub adds `(#N)` to its title so it links back to the PR. Check that the
   final commit title is the PR title and the body reads well before confirming.
5. **Bump.** `pnpm release <patch|minor|major>` bumps `packages/extension/package.json`,
   commits, and tags. A bug fix is a patch. A new capability is a minor.
6. **Push the tag.** `git push --follow-tags`. The tag starts
   `.github/workflows/release.yml`, which builds the Chrome, Firefox, and sources zips and
   opens a DRAFT release whose notes are generated from the PRs merged since the last tag.
7. **Publish.** Wait for that run, then
   `gh release edit v<x.y.z> --title "v<x.y.z>" --draft=false --latest`. Do not leave it as a
   draft.

**Notes are generated, not written.** Keep GitHub's `## What's Changed` list and its
`**Full Changelog**` link. Only edit them to drop noise (a revert pair, a chore nobody
sees) or to fix a PR title that reads badly. Never replace them with a hand-written file,
and never add install, usage, or contributor sections. A good PR title is what makes this
work, so spend the effort there.

**Title: the version and nothing else.** `v1.10.2`. No summary after it.

**Prose style for notes, PR titles, and commit messages: Simplified Technical English.**
Short sentences, one idea each. Active voice. Plain, common words. No idiom, no marketing.
A commit body still explains WHY, it just says it plainly. This matches the terse style the
owner reads everything else in.

## UI & visual design (settled — `packages/extension/lib/ui`)
The look and these rules are **settled**; don't relitigate spacing/colour/structure or invent new patterns without being asked. The user cares a lot about **consistency** — uniformity across surfaces is the bar. When adding UI, reuse the kit and match the rules below.

- **Stack:** Tailwind v4 (tokens + base in `lib/ui/theme.css`, wired via `@tailwindcss/vite`). Brand accent is **Trakt red** (`bg-trakt` / `text-trakt`). A shared kit in `lib/ui/kit/` holds the tokens + primitives (`tokens()`, `Btn`, `IconBtn`, `Switch`, `Stars`, `Icon`, `TraktMark`, `AniListMark`, `MalMark`, `SimklMark`, and `TrackerMark`, the one tracker → mark lookup) and the presentational views (`PopupView`, `PickerPanel`, `BadgeView`, `QuickLinksView`, `OptionsView`). Real entrypoints stay thin and feed these props.
- **Theme: dark is the chosen direction** (`tokens("dark")`). A light token set still exists and must keep working, but dark is what ships.
- **Gallery harness:** `entrypoints/gallery/` renders every surface + state with mock data and a light/dark switch — the prototyping/review tool. Keep it updated when you add UI states. View via `pnpm dev` → `chrome-extension://<id>/gallery.html`.
- **Consistency rules (keep uniform across popup / picker / badge / quicklinks / options):**
  - Icon actions (close, minimize, reorder, edit, delete) use the **borderless `IconBtn`** (hover state, no ring). Never mix bordered and borderless icon buttons.
  - **Destructive** actions are a **trash `IconBtn` (`danger`)**, identical everywhere (recipes, corrections, quick links).
  - Text buttons: `primary` (filled red) = the main action; `ghost` = secondary (Refresh, Add, Disable, Copy JSON); `danger` (ghost-rose) = bulk-destructive (Clear all).
  - **Red underline is for genuine inline text links only** (e.g. "contribute here"). Never style a button as red underlined text.
  - All interactive controls get `cursor: pointer` (restored in the theme base layer; Tailwind v4 preflight defaults buttons to `default`).
  - In any header show **either the logo mark or the wordmark — not both**.
- **Account section is a provider list**, **one row per tracker** (today four: Trakt, AniList, MyAnimeList, Simkl). Each row is mark + name + status + Connect/Disconnect, and NAMES the provider so "Connect" is never "connect to what?". The rows are independent connections; which trackers an item goes to is the per-recipe toggle set (constraint #1), not the account list. Reuse the existing provider-row component for both; don't invent a second pattern. Section is labelled "Account".
- **Injected UI + Tailwind (Shadow DOM):** badge / picker / quicklinks render inside a Shadow DOM. Tailwind v4 emits its theme custom properties on `:root`, which do **not** reach a shadow root — so `var(--color-*)` (i.e. every colour utility) is unresolved there. Wiring Tailwind into the injected surfaces requires making the theme vars available inside the shadow scope (mirror them onto `:host`) — solve and document this when wiring those three. (Popup + options are normal pages and need none of this.)

## Testing
- **Vitest** for `shared` (schema, `extract` against saved HTML snapshots — keep fixtures in `packages/extension/test/fixtures/`).
- **Playwright** for extension E2E (load the built extension, drive a fixture page, assert a scrobble call).
- Add a recipe-snapshot harness early: given saved DOM + a recipe, assert the parsed media. Most regressions are recipe rot; this catches them.

## Drift guards — do NOT do these
- Adding a tracker is allowed (the registry is pluggable). But it must go **behind the adapter seam** (a `TrackerAdapter`) + a picker toggle; never special-cased in the shared engine. (Letterboxd stays a CSV *export target*, not a tracker.)
- Do not put the anime-map crosswalk (or any episode-mapping / is-anime logic) into the shared `extract()` engine. It lives in `lib/trackers/animap/` + the adapters. This is the hard rule for the crosswalk.
- Do not resurrect a "primary tracker" tab/selector in the picker — trackers are **independent toggles**; native-vs-derived is inferred at runtime.
- Non-anime (movies, Western TV) may be multi-tracked only to Trakt and Simkl, which take seasoned numbering and tmdb/imdb ids as scraped, so no crosswalk is involved. Simkl is the `any` family: it gets the page's own numbering and never goes through the crosswalk. Never send non-anime through the anime-map crosswalk or to a cour-family tracker (AniList, MAL).
- Do not silently mis-write a derived tracker: **refuse-on-ambiguous** + per-tracker `progress > episodes` guardrail; each tracker is advance-only and never lowers remote progress (`docs/ARCHITECTURE.md`, "Multi-tracking").
- Keep the recipe library as ONE tracker-agnostic file (`recipes/index.json`): every recipe names its own trackers and the engine routes per-recipe. Do NOT introduce per-tracker recipe files/directories: they bake the tracker into the layout and don't scale as trackers are added.
- Do not give AniList a fake scrobble loop — it has no scrobble API; one `SaveMediaListEntry` write per episode at threshold.
- Do not create `packages/server` or any hosted DB/voting system in v1.
- Do not store session state, timers, or buffers in the background service worker (the only exception is a running list sync job, constraint #4).
- Do not request `<all_urls>` or put host permissions in the install manifest.
- Do not let recipes carry or run JavaScript; no `eval`/`new Function`/remote scripts.
- Do not send watch history anywhere except the user's own tracker accounts (Trakt / AniList / MAL / Simkl).
- Keep the **injected** content UI (badge / picker / quicklinks) lean and Shadow-DOM-friendly — it ships on every granted page, so mind bundle weight and style isolation (Tailwind + headless primitives are fine; avoid a heavy CSS-in-JS runtime in the content script). The **options page** has no weight budget — use whatever UI kit/design system you like there.
