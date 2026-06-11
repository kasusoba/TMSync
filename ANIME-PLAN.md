# ANIME-PLAN.md — adding AniList for anime

Working checklist for the AniList integration. Direction + rules are settled in `CLAUDE.md`
(see the 2026-06 direction note + the **Tracker adapters** section). This file is just the
build order and progress; delete it once shipped.

## Scope recap (settled — do not relitigate)
- Routing: **anime series → AniList; movies (anime or not) + non-anime TV → Trakt.** One item, one tracker. No cross-tracker sync/mapping.
- **Dedicated anime sites only** (numbering already matches the AniList entry). Absolute↔entry offset mapping, the TMDB/general-site anime path, and the is-anime classifier are a **non-goal (decided 2026-06)** — not deferred, not planned. They only serve Trakt↔AniList parity, which TMSync isn't. If ever revisited they live ONLY inside the AniList adapter, never the shared `extract()` engine.
- Anime recipes live in `recipes/anime/`, separate from the public `recipes/trakt/` list.
- AniList = OAuth (no backend), GraphQL, `SaveMediaListEntry` (no scrobble API → we own the watched decision via `watchedThreshold`, one idempotent write per episode). **Auth: Authorization Code grant** — AniList removed implicit grant (`unsupported_grant_type`), so we exchange a code for a token using a bundled secret, same as Trakt (still no backend).

## Build order
- [x] **1. Schema** — `tracker: "trakt"|"anilist"` (default `"trakt"`) added to the Zod recipe schema; `SCHEMA_VERSION` already 2 (it covers manual recipes + now `tracker`, an additive optional field — no further bump needed). Fixtures + a live-`index.json` parse test confirm v1 recipes still parse and default to `trakt`.
- [x] **2. Adapter seam** — `lib/tracker/` (`TrackerAdapter` interface + `getAdapter()` registry). Trakt logic moved behind `lib/trakt/adapter.ts` (thin wrapper over the unchanged client — scrobble logic, <1% pause skip, 409/HTTP handling identical). Background routes scrobble/resolve/reconcile through the adapter; `tracker` threaded through messaging + session + `TabSession`. `ratingLevels()` exposed per tracker.
  - Note: `rate()`/`setNote()` for the seam land in the background's routed rating handlers (step 7), not as separate interface methods; `postPublic()` stays deferred.
- [x] **3. AniList adapter** — implicit-grant OAuth (`lib/anilist/auth.ts`), thin GraphQL client (`client.ts`: `resolve` via `Media(search, type: ANIME, format_not: MOVIE)`, cached; `SaveMediaListEntry`; `viewerScoreFormat`). `lib/anilist/adapter.ts` does the threshold write (idempotent via `anilistProgress`, never lowers). Second **Account row** added to popup + options (+ gallery) reusing a shared provider-row. Host permission `graphql.anilist.co` + `WXT_ANILIST_CLIENT_ID`.
- [x] **4. Routing** — `getAdapter(recipe.tracker)` selects the adapter in the background; `extract()` untouched (tracker-agnostic).
- [x] **5. First anime recipe** — `recipes/anime/index.json` (Gogoanime/anitaku, `tracker: "anilist"`), kept separate from the public Trakt list, bundled + merged at load. *Live AniList-write validation still needs a real `WXT_ANILIST_CLIENT_ID` + a logged-in run.*
- [x] **6. Numbering guardrail** — `planAniListWrite()` refuses a write whose episode exceeds `Media.episodes` (`numbering_mismatch`), surfaced as a badge warning instead of corrupting. Unit-tested.
- [x] **7. Rating & private note (AniList)** — score (stars→`scoreRaw`) + `MediaList.notes`, both via `SaveMediaListEntry` on the cour entry. Badge rating UI is adapter-driven (AniList shows a single "rate this cour", private note, no spoiler/word-min). Public `Review` (`postPublic`) deferred.

## Known follow-ups (not blocking the core anime→AniList path)
- Remote anime-list fetch: the anime list is currently **bundled only** (Trakt list still fetches from CDN). Add a second CDN URL + fetch if desired.
- Score scale: stars are 1–10 mapped to `scoreRaw` (0–100); `scoreFormat` is read/returned but the badge doesn't yet render POINT_5/POINT_3 natively.
- No AniList correction flow in the badge ("wrong match?" is Trakt-only in v1).

## Non-goal — will NOT build (see CLAUDE.md constraint #2 + drift guards)
- Absolute↔AniList-entry offset mapping; TMDB/general-site anime; is-anime classifier.
- Why: anime viewers use dedicated anime sites; the general-site path only serves Trakt↔AniList parity, which TMSync rejects. Decided 2026-06 (reconsidered and dropped).
- Mapping-DB background, reference only (do not start building): `Fribb/anime-lists`, `Anime-Lists/anime-lists` (`anime-list-master.xml`), `manami-project/anime-offline-database`, `MALSync/MAL-Sync-Backend`.
