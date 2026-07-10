# MULTI-TRACK.md — dual-tracking anime to Trakt **and** AniList

**Status:** proposed (2026-07). Design + phased plan for review. Nothing here is built yet.
**Supersedes:** the "route, never sync" half of CLAUDE.md constraint #1, the whole of constraint #2's non-goals, and the "Non-goal" section of `docs/ANIME-PLAN.md`. See **§14 Constraint migration** for the exact doc edits — those are staged, not yet applied.

> This is an intentional reversal of a previously-settled decision, made by the owner with data (§3). A future session must NOT "fix" multi-tracking back to routing as drift. When this doc and the old constraints disagree, **this doc wins**, exactly as the 2026-06 anime direction note overrode the original "Trakt-only" scope.

---

## 1. The decision

TMSync moves from **route** (each item → exactly one tracker, decided by type) to **multi-track** (an item may be written to *both* Trakt and AniList at once), Mihon/Aniyomi-style. One master pick, per-recipe tracker toggles, each toggle disabled until its tracker's required fields are satisfied.

What stays true: **still exactly two trackers** (Trakt + AniList — constraint #1's *count* is untouched; no Simkl/MAL/Kitsu/Letterboxd). Watch data still goes only to the user's own accounts (constraint #6). No backend (#7). Recipes stay declarative data (#3). The MV3/service-worker/permissions rules (#4, #5) are unchanged.

## 2. Scope — multi-track only ever means *anime*

Non-anime movies and Western TV **don't exist on AniList**, so their "multi-track" degenerates to Trakt-only automatically. The feature is therefore, precisely:

> **anime (movies + series) dual-writes to AniList + Trakt; everything else stays Trakt-only.**

Degradation is first-class, not an error: if the "other" tracker can't be resolved for an item (no crosswalk hit, ambiguous mapping, not connected), we write the one we can and **log the skip** — never block the tracker that *did* resolve. A partial multi-track is the expected common case (see coverage in §3).

## 3. Evidence (why this is now viable, not theory)

Pulled `Fribb/anime-lists` → `anime-list-full.json` (42,152 entries) and measured it locally:

| finding | number |
|---|---|
| entries with an `anilist_id` | 20,471 (49%) |
| entries with a `themoviedb_id` | 8,412 (20%) |
| **usable TMDB↔AniList crosswalk** (both) | **8,091 (19%)** |
| AniList entries with **no** TMDB id | 60% ← degrades to AniList-only |
| distinct TMDB *tv* ids → exactly 1 AniList entry | 71% |
| … → >1 AniList entry (multi-cour) | 29% (up to ~49 for long runners) |

The schema carries `season: {tmdb, tvdb}` **and** `episode_offset`, so the anime numbering problem is **~97% mechanically resolvable** (81% trivial 1:1, 16% via season+offset, **3% ambiguous**). Shippable trimmed subset (TV/ONA, anilist+tmdb) = **180 KB raw / 33 KB gzipped**.

**The crosswalk doubles as the is-anime classifier** — "is this TMDB id in the crosswalk?" answers it; no separate heuristic. **The real wall is coverage, not math** (19% overall, skewed toward obscure/OVA — mainstream airing TV is better, untested). A crosswalk *miss* = AniList-only, a soft degrade. A *wrong* mapping = silent desync, the thing to guard hardest against (§9, §12).

Worked example — Attack on Titan (TMDB tv 1429 → 8 AniList entries): TMDB season 3 splits into two AniList entries (`99147` offset 0, `104578` offset 12). Site says S3E15 → offset-12 entry, local ep = 15−12 = 3. Resolves cleanly.

## 4. Core model — **native** vs **derived** tracker

The clean framing that makes the whole thing tractable:

- Every recipe has a **native numbering** — the coordinate system its `extract()` already produces.
  - A **general/TMDB site** speaks *TMDB* (scrapes `tmdbId` + TMDB season/episode) → **native = Trakt**.
  - A **dedicated anime site** speaks *AniList* (linear episode matching the cour entry) → **native = AniList**.
- The native tracker is written **directly** (today's paths, unchanged).
- The **other** tracker is **derived** through the crosswalk — best-effort, refuse-on-ambiguous, skip-on-miss.

So the crosswalk is used in whichever direction the site *doesn't* natively speak:

| site type | native (direct) | derived (via crosswalk) |
|---|---|---|
| general / TMDB | Trakt: pass `tmdbId` + season/ep as scraped | AniList: `tmdb+season → entry`, local ep = `tmdb_ep − offset` |
| dedicated anime | AniList: write linear ep (existing) | Trakt: `anilist_id → tmdb+season+offset`, `tmdb_ep = ep + offset`, then `/search/tmdb` → Trakt id |

Native is inferred from the recipe's extracted fields (has `tmdbId` ⇒ TMDB-native; else title+linear-episode ⇒ AniList-native) or set explicitly (§6, open question).

## 5. The anime-map crosswalk (`lib/animap/`)

> Naming: call this the **anime-map** (derived from Fribb `anime-lists`) to avoid collision with the *existing* `quickLinkSlugs` storage item, which is an unrelated local `(host, AniList id) → slug` cache for anime quick links.

- **CDN from day one** (decided) — a versioned JSON list fetched like the recipe list (constraint #7: still no backend; a public GET, no watch data leaves the client — constraint #6). Bundled seed for offline/first-run, refreshed on the recipe cadence (new cours appear each season). Trimmed to what we need: `{ anilist_id, tmdb_id, tmdb_kind: "tv"|"movie", tmdb_season, episode_offset, type }` — ~33 KB gzipped.
- **Two indices** built at load: `byTmdb` (forward, general sites) and `byAnilist` (reverse, dedicated sites).
- **Resolution returns a discriminated result**, never a silent guess:
  - `resolved` → `{ anilistId | traktTarget, localEpisode }`
  - `ambiguous` → >1 candidate shares the TMDB season with no offset to split (the 3%) → **refuse the derived write, surface a warning** (reuse the `numbering_mismatch`-style badge).
  - `miss` → not in crosswalk → derived tracker **skipped** (native-only), logged, no warning.
- Lives **entirely in `lib/animap/` + behind the adapters** — the shared `extract()` engine never imports it (the one rule constraint #2 keeps even in reversal).

## 6. Schema change — **DONE** (Phase 1, additive, no version bump)

Keep `recipe.tracker: Tracker` as the **primary/native** tracker and **add an optional `recipe.trackers: Tracker[]`** — the full toggled set. Read via the new pure helper **`recipeTrackers(recipe)`** (`packages/shared`), never `recipe.trackers` directly; it returns the primary-first, deduped, primary-guaranteed set (falls back to `[tracker]`).

- **No `SCHEMA_VERSION` bump.** The field is additive-optional, so v1/older-v2 recipes are unchanged, and an older engine that ignores `trackers` degrades to native-only (`[tracker]`) — a graceful degrade, *better* than a version gate that would make old clients drop a multi-track recipe entirely.
- **`tracker` doubles as the "native" signal** — no separate `primaryTracker` field needed (open Q1 resolved: infer). Native numbering = whatever the primary tracker speaks.
- Recipes live in ONE tracker-agnostic list (`recipes/index.json`); each recipe's `tracker` field routes it. (The old separate `recipes/anime/` file was retired 2026-07 — tracker is a field, not a directory.)
- Shipped in `schema.ts` + `recipeTrackers()` + `test/multi-track-schema.test.ts` (7 cases: default, explicit, primary-guarantee, dedupe, back-compat, unknown-tracker reject).

## 7. Routing → `routeTrackers`

`routeTracker(tracker, mediaType): Tracker` → **`routeTrackers(recipe, media): Tracker[]`** — the set to *attempt* for this item:

- non-anime movie / Western TV → `["trakt"]`
- anime series, recipe toggles both, crosswalk resolves → `["trakt", "anilist"]`
- anime series, only AniList toggled or Trakt derive misses → `["anilist"]`
- anime movie (Phase 1) → `["trakt", "anilist"]` when both toggled + resolved

The old `mediaType === "movie" → trakt` shortcut is retired: anime movies may now go to both.

## 8. Session fan-out

`SessionManager` holds a **set** of active adapters, not one:

1. **Resolve per tracker** on match: native adapter resolves directly; derived adapter resolves via crosswalk. Cache each independently (per-tracker resolution cache keys already exist). A derived `miss`/`ambiguous` drops that tracker from the active set for the session.
2. **Record per tracker** on each phase: `for (adapter of active) adapter.recordProgress(item[adapter], media, progress, phase, threshold)`. The two paradigms coexist untouched — Trakt gets real `start/pause/stop`; AniList no-ops start/pause and threshold-writes on `stop`. The adapter interface (`TrackerAdapter.recordProgress`) already supports this per-adapter; the session just calls N of them.
3. **Aggregate** the N `RecordResult`s into one badge state: all-ok → "scrobbled ✓"; mixed → per-tracker chips (e.g. `Trakt ✓ · AniList ⚠ numbering`); each tracker keeps its own reason.

No background state changes (constraint #4): session state stays in the content script + storage; the background stays stateless and routes to `getAdapter()` per tracker as it does now.

## 9. Progress semantics — independent, advance-only (this is why conflict logic stays small)

Each tracker is written **independently**, and each is **advance-only**:

- **Read-before-write per tracker**, `progress = max(remote, scraped)`, **never lower** (AniList already does this; Trakt owns its own ≥80% decision).
- Because neither tracker can be *lowered* and each lives in its own numbering, there is **no cross-tracker arbitration** — no "which progress wins." Divergence is benign (one tracker may be ahead if the user advanced it elsewhere).
- The **only** real failure is a *wrong mapping* writing the wrong episode to the derived tracker → silent desync. That is caught by refuse-on-ambiguous (§5) + the per-tracker `progress > Media.episodes` guardrail (already built for AniList — extend the spirit to the derived Trakt target).

## 10. Rating & reviews fan-out

Rate once → write to **every toggled+resolved tracker**, each in its own shape (the seam is already adapter-driven via `ratingLevels(media)`):

- Trakt: 1–10 at show/season/episode; AniList: the user's `scoreFormat` on the **cour entry** only.
- Private note fans out too (Trakt VIP note / AniList `MediaList.notes`).
- Public `postPublic` (Trakt comment / AniList Review) stays **deferred** for multi-track just as in v1.
- Badge rating UI renders the **union** of `ratingLevels` across active trackers, labelled per tracker so "rate this cour" (AniList) and "rate S2E5" (Trakt) can coexist.

## 11. Picker / master-data UI (the Mihon UX)

- **One picker** over a **master record**: `{ title, year, tmdbId?, season?, episode?, anilistId? }` — the superset both trackers draw from. Replaces the current two-path split.
- **Per-recipe tracker toggles.** Each adapter declares its **required master fields**; a toggle is disabled (greyed) until they're present — exactly "field required for a tracker not filled ⇒ disabled." Trakt enables on `title` **or** `tmdbId`; AniList enables on `title` (and, on a TMDB-native site, a crosswalk hit from `tmdbId`).
- Reuses the existing provider-row / kit primitives (CLAUDE.md UI rules — no new patterns). The Account section already lists both providers as independent connections; multi-track doesn't change that (two connections, now both may receive one item).

## 12. Safety & failure semantics (fail loud, never silently corrupt)

- **Refuse-on-ambiguous** (§5) — the 3% shared-season-no-offset case never guesses; it warns and writes native-only.
- **Per-tracker numbering guardrail** — reuse `numbering_mismatch`: if a derived episode exceeds the target entry's episode count, refuse that tracker's write and surface it.
- **Skip-on-miss is silent-but-logged** — a crosswalk miss is a normal degrade to native-only, not a warning (would be noise); counted for diagnostics.
- **Rewatch confirmation still applies per tracker** — a `COMPLETED` AniList cour still needs the existing "Rewatching?" confirm before REPEATING; Trakt keeps its own behavior. `needs_rewatch` stays a per-tracker reason.
- New `RecordResult.reason`s: `crosswalk_miss`, `crosswalk_ambiguous` (alongside existing `numbering_mismatch`, `needs_rewatch`, …).

## 13. Phased build plan

**Phase 1 — anime *movies* dual-track (lowest risk, proves the machinery).**
No episodes ⇒ zero numbering risk. Resolve an anime movie on both (Trakt via `tmdbId`/title; AniList via `Media` `format: MOVIE` + the `movie` crosswalk row), mark watched on both at stop/threshold, rate on both. Delivers: `trackers[]` schema + loader normalization, `routeTrackers`, session fan-out over N adapters, badge aggregation, rating fan-out — all without touching episode math. Ships as a real, safe feature on its own.

**Phase 2 — anime *series* on dedicated anime sites.**
Native = AniList (existing linear write). Derive Trakt via the **reverse** crosswalk (`anilist_id → tmdb+season+offset`, `tmdb_ep = ep + offset`, `/search/tmdb` → Trakt id). Adds `lib/animap/` + the reverse index + refuse-on-ambiguous + the derived-Trakt guardrail. Coverage-limited (19%) → many stay AniList-only; that's expected.

**Phase 3 — general-site anime (the crosswalk classifier).**
Native = Trakt. Derive AniList via the **forward** crosswalk (`tmdb+season → entry`, `local ep = tmdb_ep − offset`). This is where the crosswalk *classifies* (miss ⇒ not-anime ⇒ Trakt-only) and where the offset math earns its keep. Highest coverage risk; gate behind clear per-item warnings.

Each phase is independently shippable and leaves the tree green.

## 14. Constraint migration (STAGED — apply on approval, not yet done)

When this design is approved, these doc edits land in the same change that starts Phase 1:

- **CLAUDE.md #1** — reword "routed, never synced / no cross-tracker mapping" → "two trackers; anime may be *multi-tracked* to both via the bundled crosswalk; non-anime stays Trakt-only." Keep the **count** (exactly two) and **no-third-tracker** rule.
- **CLAUDE.md #2** — the general-site-anime / offset-mapping / is-anime-classifier **non-goal is lifted**; replace with "built via the crosswalk, quarantined in `lib/crosswalk/` + the adapters, never in `extract()`."
- **CLAUDE.md "Drift guards"** — remove "no cross-tracker sync/mapping" and "don't build the anime hard-cases"; add "crosswalk stays out of `extract()`" and "still exactly two trackers, no third."
- **CLAUDE.md "Tracker adapters"** — the routing table and "one item → one tracker" prose → the native/derived model (§4).
- **docs/ANIME-PLAN.md** — mark its "Non-goal" section reversed; point to this doc.
- Update the memory `multi-track-pivot` once shipped.

## 15. Decisions & open questions

**Resolved (2026-07):**
1. ~~Native inference vs explicit `primaryTracker`~~ → **infer.** The primary `tracker` field *is* the native signal; no extra field (§6). Add one later only if a real recipe proves inference wrong.
2. ~~Crosswalk hosting~~ → **CDN from day one** (versioned JSON like recipes; bundled seed for first-run).
5. ~~Backfill~~ → **forward-only.** Enabling a second tracker on an already-tracked anime tracks forward from that point; no historical reconcile in v1.

**Still open:**
3. **Absolute-numbered general sites** — the forward crosswalk assumes TMDB season/episode; a site showing a single absolute number needs an absolute→season pre-step (per-season episode counts). Phase 3 sub-task; **refuse rather than guess** until built.
4. **Badge density** — two-tracker status in a small badge; likely a compact "T·A" chip pair. UI review before Phase 1's badge aggregation (§8) lands.
