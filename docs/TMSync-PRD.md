# TMSync — Product Requirements (v0.1)

## 1. What it is
A cross-browser extension that **automatically scrobbles movies and TV shows to Trakt** while you watch them on streaming sites — including gray-market/aggregator sites that have no API. Conceptually: *MAL-Sync, but for live-action and targeting Trakt.*

It detects what you are watching from the page, resolves it against Trakt, and marks it watched once you cross a progress threshold — with no manual logging.

## 2. Why
- Existing tools fall short: MAL-Sync is anime-only; Universal Trakt Scrobbler is robust but tied to official-service integrations and won't touch pirate sites.
- The author already runs Trakt-on-site integrations manually and wants the passive, "it just tracks" experience MAL-Sync gives anime, for the rest of their viewing.

## 3. Goals
- Passive, automatic scrobbling of movies/TV to Trakt on arbitrary video sites.
- Add support for a new site **on the fly** via an in-page element picker — no code, no rebuild.
- Share site definitions so others benefit (start as repo/PR, evolve to live crowdsourcing).
- Survive site churn: definitions keyed on stable signals and resilient to clone/mirror domains.
- Stay store-compliant and privacy-respecting despite broad reach.

## 4. Non-goals (explicitly out of scope)
- **Anime.** Handled by MAL-Sync. Do not build anime support or anime ID/episode mapping.
- **Multiple trackers / cross-tracker ID mapping.** Trakt only. (Keep a thin adapter seam for a *possible* future Simkl adapter; do not build it.)
- **A backend service in v1.** Site definitions ship as a versioned list in the repo (see §8).
- **Two-way sync** between trackers. This is a one-way scrobbler (watch event → Trakt).
- One Pace / fan-recut mapping. Deferred indefinitely; out of scope here.

## 5. Users
- Primary: the author and similar power users who watch movies/TV on a rotating set of streaming/aggregator sites and want effortless Trakt history.
- Secondary: contributors who add/maintain site definitions.

## 6. Core user flow
1. **Install & connect.** Light install prompt (no broad host access). Connect Trakt once via OAuth.
2. **Watch on a known site.** A small Shadow-DOM badge shows the matched title + episode and the target (Trakt). Playback is scrobbled in real time (start/pause/stop), so the profile shows "currently watching" and the item is marked watched at the end. Ambient, SponsorBlock-style.
3. **Wrong match.** Click the badge → pick the correct Trakt entry → remembered per (site, show). Optional "share this fix."
4. **Unknown site.** Badge offers "set this up." User grants per-site permission, then uses the **element picker** (uBlock-style) to point at title / episode (or confirm auto-detected page metadata). Live preview confirms extraction. Optionally contribute the recipe.
5. **(Built-in) asbplayer note.** `app.asbplayer.dev` is just another site the engine can target if the author later wants local-file tracking; not a v1 priority.

## 7. The recipe model (keystone)
A **recipe** is **declarative data** describing *what to extract*, never code. The extension ships a fixed, reviewed interpreter that executes recipes. (Rationale: MV3 + store policy ban remote code; and arbitrary crowdsourced JS would be a security hole.)

- Extraction sources, in order of preference: `url` → `meta` (Open Graph) → `jsonld` (`VideoObject`/`TVEpisode`/`Movie`) → `dom` (last resort) → `title` (`document.title`).
- Recipes are matched by **DOM fingerprint + URL pattern**, not domain alone, so one recipe covers a site's many clone/mirror domains.
- Each recipe carries a **schema version**; clients ignore recipes requiring a newer schema than they understand.
- Full schema lives in `CLAUDE.md` and is the source of truth (`shared/` package, validated with Zod at runtime).

## 8. Crowdsourcing — phased
- **Phase 1 (v1):** recipes are a JSON list in the Git repo, served via CDN/raw GitHub, contributions via pull request (EasyList/uBlock model). No server, no hosting, no moderation backlog.
- **Phase 2 (later, only if needed):** a SponsorBlock-style service for live submission with voting, freshness/staleness detection, and abuse controls. The client fetches a recipe list either way, so this is an additive change.
- Mapping note: live-action uses TMDB/IMDb IDs as a universal key, so a *second* tracker later would be near-free. This is why no cross-tracker mapping DB is needed (that pain was anime-specific).

## 9. Architecture (high level)
- **Content script** (`all_frames: true`): finds the `<video>`, listens to `play/pause/timeupdate/ended`, applies the matched recipe, owns the watch-session state, draws the Shadow-DOM badge/correction UI and the element picker. Handles the **iframe split** (player often in a cross-origin iframe while title/episode live in the top page) by coordinating across frames via messaging.
- **Background (MV3 service worker, stateless):** resolves identity via Trakt search, calls the Trakt scrobble/history API, holds OAuth token in storage. Treated as ephemeral — reads everything from storage on each wake.
- **Options page:** Trakt connection, per-site permission management (the "missing permission → grant" banner), enabled-sites list, recipe overrides/corrections.
- **`shared/` package:** recipe schema + Zod validators + types, imported by extension and (future) server.

## 10. Permissions & distribution
- `optional_host_permissions: ["*://*/*"]`, **no broad `host_permissions`** at install. Request per-origin on a user gesture, then `registerContentScripts` (persists across restarts).
- Ship on **Chrome Web Store and Firefox AMO**. Expect more friction on Chrome for a piracy-adjacent tool; lead with Firefox if needed. (MAL-Sync demonstrates this posture survives on both.)

## 11. Privacy
- All resolution and scrobbling happen **client-side**. Watch history goes only to the user's own Trakt account.
- The (future) backend only ever receives **anonymous recipe submissions** — never watch history. Design this separation from day one; it is also the answer to "high-risk extension" perceptions.

## 12. Success criteria (v1)
- Scrobbles correctly on a starter set of hand-written recipes across ≥5 sites.
- A user can add a brand-new site via the picker in under a minute, without touching code.
- Survives a clone-domain swap without a recipe change (fingerprint match holds).
- Clean install prompt; per-site grants only; passes AMO review.

## 13. Open questions / later
- **Resolved — scrobbling is real-time** (start/pause/stop), giving live "currently watching" profile presence. The watched mark is Trakt's own ≥80%-on-stop decision, not a separate client threshold. Avoid event spam (debounce play/pause) and always send a `stop` on leave, persisting progress so the background can reconcile if the page dies.
- Recipe vocabulary breadth — how many transforms are needed before sites are coverable without code.
- When/whether Phase 2 server is worth the operational cost.
