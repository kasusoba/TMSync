# ANIME-PLAN.md — adding AniList for anime

Working checklist for the AniList integration. Direction + rules are settled in `CLAUDE.md`
(see the 2026-06 direction note + the **Tracker adapters** section). This file is just the
build order and progress; delete it once shipped.

## Scope recap (settled — do not relitigate)
- Routing: **anime series → AniList; movies (anime or not) + non-anime TV → Trakt.** One item, one tracker. No cross-tracker sync/mapping.
- **Dedicated anime sites only** (numbering already matches the AniList entry). Absolute↔entry offset mapping, the TMDB/general-site anime path, and the is-anime classifier are a **non-goal (decided 2026-06)** — not deferred, not planned. They only serve Trakt↔AniList parity, which TMSync isn't. If ever revisited they live ONLY inside the AniList adapter, never the shared `extract()` engine.
- Anime recipes live in `recipes/anime/`, separate from the public `recipes/trakt/` list.
- AniList = implicit-grant OAuth (no backend), GraphQL, `SaveMediaListEntry` (no scrobble API → we own the watched decision via `watchedThreshold`, one idempotent write per episode).

## Build order
- [ ] **1. Schema** — add `tracker: "trakt"|"anilist"` (default `"trakt"`) to the Zod recipe schema in `packages/shared`; bump `SCHEMA_VERSION` to 2. Update fixtures + snapshot tests. Confirm old (v1) recipes still parse and default to `trakt`.
- [ ] **2. Adapter seam** — extract existing Trakt logic behind a `TrackerAdapter` interface: `resolve()`, `recordProgress()`, **plus the existing rating/comment path** (`ratingLevels()`, `rate()`, `setNote()`, optional `postPublic()`). Pure refactor, **no behavior change**; Trakt path (scrobble *and* rating/comment) must stay byte-for-byte equivalent. This proves the seam before AniList exists.
- [ ] **3. AniList adapter** — implicit-grant OAuth via `launchWebAuthFlow`; thin GraphQL `fetch` client; `resolve()` (title → `Media` id, cache it) + `recordProgress()` (threshold crossed → `SaveMediaListEntry(mediaId, progress, status)`, idempotent, never lower progress). Read `mediaListOptions { scoreFormat }` for score display. Add the **second Account row** (AniList) reusing the existing provider-row component.
- [ ] **4. Routing** — engine selects the adapter by `recipe.tracker`. `extract()` stays tracker-agnostic.
- [ ] **5. First anime recipe** — one dedicated anime site under `recipes/anime/`, validated end-to-end against a real AniList write. Add to the gallery harness if it introduces new UI states.
- [ ] **6. Numbering guardrail (AniList `recordProgress`)** — before writing, if scraped `progress` > the resolved entry's `Media.episodes`, refuse and surface a "site numbering doesn't match AniList" warning instead of writing. Turns the common mis-authoring (anilist recipe on a TMDB/absolute-numbered site) from silent corruption into a loud, fixable error.
- [ ] **7. Rating & private note (AniList)** — implement `ratingLevels()`/`rate()`/`setNote()` for the AniList adapter: score (per the user's `scoreFormat`) + `MediaList.notes`, both via `SaveMediaListEntry`, both at the **cour entry** (no per-episode score). Make the rating UI adapter-driven (render only supported levels — anime shows a single "rate this cour"). Public `Review`/comments (`postPublic`) deferred.

## Non-goal — will NOT build (see CLAUDE.md constraint #2 + drift guards)
- Absolute↔AniList-entry offset mapping; TMDB/general-site anime; is-anime classifier.
- Why: anime viewers use dedicated anime sites; the general-site path only serves Trakt↔AniList parity, which TMSync rejects. Decided 2026-06 (reconsidered and dropped).
- Mapping-DB background, reference only (do not start building): `Fribb/anime-lists`, `Anime-Lists/anime-lists` (`anime-list-master.xml`), `manami-project/anime-offline-database`, `MALSync/MAL-Sync-Backend`.
