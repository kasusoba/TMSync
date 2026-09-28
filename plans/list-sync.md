# Plan: list sync

Status: draft, not built. This file is a working plan, not a doc. It lives only on the
`feat/list-sync` branch. Before the PR merges, the facts that stay true move into
`docs/ARCHITECTURE.md` and `docs/TRACKERS.md`, and this file is deleted. The squash merge
keeps it off `main`.

## Goal

A "Sync now" button in Options. It reads the list of every connected tracker, plans the
changes that make them agree, shows the plan, and applies it when the user confirms.

- **Scope:** watch progress, status, and rating. Notes, favorites, and custom lists are out.
- **Merge rule:** union. Each tracker gets everything the others have. Nothing is removed.
- **Trigger:** manual only. A daily run is a later phase, and it reuses the same engine.

## Shape

1. **Read.** Each tracker's service gets an optional `readList()` that returns its whole list
   as normalized entries (ids, progress or watched set, status, rating, timestamps). It is on
   `TrackerService`, not the adapter, so the content scripts never bundle it.
2. **Match.** Group entries that are the same thing on different trackers. Ids only, never a
   title search (search costs Simkl quota, and a title match can be wrong).
3. **Plan.** A pure function in `lib/sync/plan.ts` turns matched groups into per-tracker
   writes plus a list of skips and conflicts. Pure means it is easy to test, like
   `cour-plan.ts`.
4. **Preview.** Options shows the plan: counts per tracker, the skips with reasons, and the
   conflicts for the user to settle.
5. **Apply.** Each adapter gets an optional `applyBatch()`. The background runs it in chunks
   and saves its position to `storage` after each chunk (constraint #4).

The crosswalk stays in `lib/trackers/animap/`. `extract()` is not touched.

## Edge cases

### A. Matching

1. **One Trakt show is many anime entries.** Trakt has one show with seasons. AniList and MAL
   have one entry per cour. The crosswalk maps (tmdb, season, episode) to (entry, local
   episode), with offsets for a split season (Attack on Titan S3 is two AniList entries).
   A multi-cour show with no season is ambiguous: skip it and report it.
2. **Season 0 (specials, OVAs, recaps).** Skip unless the crosswalk maps them one to one.
3. **Anime movies.** A tmdb movie maps to one AniList movie entry. Two ids for one movie is
   ambiguous: skip.
4. **Not in the crosswalk.** A new show, or an entry Fribb does not know. Skip and report.
   Never guess.
5. **Is it anime?** Only the crosswalk (or a Simkl `anime` entry) makes a Trakt item anime.
   Non-anime never goes to AniList or MAL (drift guard).
6. **AniList and MAL.** Bridge by `idMal`, one to one. An entry with no `idMal` (some adult
   or very new entries) does not reach MAL.
7. **Simkl reads.** Simkl splits its list into `movies`, `shows`, and `anime`. Its anime
   entries are per cour and carry `mal` / `anilist` ids, so they match AniList and MAL by id
   directly. To reach Trakt they need the crosswalk in reverse. This is the first time a
   Simkl read goes through the crosswalk. Simkl WRITES still take any numbering and never use
   it, so the CLAUDE.md rule for scrobbling still holds.
8. **Items only one tracker knows.** Trakt answers `not_found` and Simkl answers 201 with
   `not_found` for items they cannot match. Read those fields and report the items.

### B. Progress

9. **A watched set versus a count.** Trakt and Simkl store which episodes were watched (maybe
   with gaps: 1, 2, 5). AniList and MAL store a count (watched up to N).
   - Set to count: use the highest watched episode. This matches what scrobbling does
     (`max(remote, ep)`).
   - Count to set: mark episodes 1 to N as watched, but only the ones not already there.
10. **Trakt history is not idempotent.** `POST /sync/history` adds a new play every time.
    The plan must diff against what Trakt already has, and a re-run must plan zero Trakt
    writes. The same applies to Simkl.
11. **The date on a backfilled watch.** Writing 300 episodes with `watched_at = now` makes
    Trakt and Simkl stats say "300 episodes today". Use the source's own date when it has one
    (AniList `completedAt` / `updatedAt`, MAL `updated_at`). Decision needed, see below.
12. **A rewatch in progress looks like low progress.** AniList `REPEATING` with progress 3,
    or MAL `is_rewatching` with 3 watched, does not mean "watched 3". The entry was completed
    before. Treat it as full progress when it is a source. Never lower it when it is a target.
13. **Airing shows.** AniList `episodes` can be null. The `progress > episodes` guardrail
    applies only when the count is known.
14. **The numbering guardrail stays.** A cour write with progress above the entry's episode
    count is refused and reported, same as scrobbling.
15. **Paused playback is not a watch.** Trakt's playback progress (Continue Watching) does not
    count. Only completed plays count.
16. **Rewatch counts.** Take the max of AniList `repeat` and MAL `num_times_rewatched`.
    Trakt play counts do not become repeats, and repeats do not become Trakt plays.

### C. Status

17. **Trakt has almost no status.** "Completed" on Trakt is derived from episodes. The only
    list states it has are the watchlist (plan to watch) and "dropped" (hidden from
    progress). Decision needed, see below.
18. **Status mapping.**

    | Meaning | AniList | MAL | Simkl | Trakt |
    |---|---|---|---|---|
    | watching | `CURRENT` | `watching` | `watching` | derived |
    | planned | `PLANNING` | `plan_to_watch` | `plantowatch` | watchlist? |
    | completed | `COMPLETED` | `completed` | `completed` | derived |
    | paused | `PAUSED` | `on_hold` | `hold` | none |
    | dropped | `DROPPED` | `dropped` | `dropped` | dropped? |
    | rewatching | `REPEATING` | `completed` + `is_rewatching` | none | none |

19. **Union does not define status.** Progress only goes up, so "the bigger one" works.
    Status has no order: one tracker says `DROPPED`, another says `CURRENT`. Proposal: when
    progress decides it (all episodes watched), status is `completed`. Otherwise the most
    recently updated entry wins, and the preview lists it as a conflict the user can flip.
20. **A completed entry is never silently changed** (CLAUDE.md). Sync never moves a
    `COMPLETED` target to `REPEATING` or back to `CURRENT`. It may still fill in a missing
    rating.
21. **Planned and dropped items spread too.** Union copies a plan-to-watch list and a dropped
    list to every tracker. That is the rule the user asked for, but the preview shows these
    counts on their own line so it is not a surprise.

### D. Rating

22. **Scales differ.** Trakt, MAL, and Simkl use 1 to 10 integers. AniList uses the user's
    `scoreFormat` (100, 10, 10 with decimals, 5, or 3 smileys). Convert through a 0 to 100
    value. MAL and Simkl round to an integer.
23. **Rounding loops.** AniList 85 goes to MAL 9 (or 8), and MAL 9 comes back as AniList 90.
    If sync overwrote ratings, each run would change them. Rule: fill empty ratings only.
    When both trackers have a rating and they are equal after converting to the target's
    scale, do nothing.
24. **Real rating conflicts.** Both rated, and the values differ after conversion. Do not
    pick one silently. List it in the preview, and the user picks, or skips.
25. **Rating levels differ.** Trakt rates show, season, and episode. The others rate only the
    entry. Map a cour rating to a Trakt season rating only when the crosswalk says that cour
    is exactly that season. Movies map to movies. Simkl show ratings map to Trakt show
    ratings. Trakt episode ratings never sync. Never average several cour ratings into one
    show rating.
26. **Zero means unrated** on AniList and MAL.
27. **The local rating mirror.** TMSync keeps a mirror of Trakt and Simkl ratings because it
    cannot read them back cheaply. A full list read is exactly that read, so sync refreshes the
    mirror.

### E. Privacy

28. **Private entries.** An AniList entry marked `private` must not be copied to a public
    Trakt profile. Default: skip it and report it. "Hidden from status lists" is not privacy
    (it is how AniList keeps an entry only in a custom list), so it syncs as usual.
29. **Adult entries** (`isAdult`). Same question. Default: skip, with an option to include.

### F. Running the sync

30. **Simkl quota** (500 a day on Free, shared with the user's other Simkl apps). Reads are
    `/sync/all-items` (one call per type). Writes are batched `/sync/history` and
    `/sync/ratings`. Budget about 10 calls a run. No per-item Simkl call, ever.
31. **MAL bursts.** One `PATCH` per entry, and MAL answers 403 to bursts. Space writes about
    1 to 2 seconds apart. On a 403, stop the MAL part, save the position, and report "resume
    later". Never retry in a loop.
32. **AniList limit** (about 90 a minute, sometimes lower). One mutation per entry. GraphQL
    aliases may allow several mutations in one request. To verify.
33. **Trakt limits.** POST is about 1 a second, so batch. Free accounts may have item limits
    on the watchlist. To verify, it matters for item 17.
34. **The worker stops mid-run.** Save the plan and the position after each chunk. On resume,
    re-read the tracker whose chunk was in flight before sending again, because a Trakt or
    Simkl history write that was sent twice is a duplicate play (item 10).
35. **A scrobble during the sync.** An AniList write from scrobbling can land between the
    sync's read and its write. The cour trackers already read before each write, so apply
    keeps that rule: `progress = max(fresh remote, planned)`. It costs a second request per
    AniList and MAL write.
36. **A stale preview.** The user opens the preview and applies it an hour later. If the
    plan is older than a few minutes, re-read and re-plan before apply.
37. **A token expires, or a tracker disconnects, mid-run.** Refresh as usual. If refresh
    fails, skip that tracker, finish the others, and report.
38. **Token refresh races.** A Simkl refresh invalidates the old access token, and the MAL
    refresh is single-flight. So the sync runs in the background (where the refreshers live),
    not in the Options page. Options only sends "start" and shows progress.
39. **Fewer than two trackers connected.** The button is disabled, with the reason shown.
40. **Choose trackers.** A per-tracker on/off in the sync panel, so the user can sync only
    AniList and MAL, for example.
41. **The first sync is large.** Thousands of Trakt episodes into AniList and MAL can take a
    long time because of item 31. Show progress, and let the user cancel. A cancel keeps what
    was already written (every write is safe on its own).
42. **Convergence.** Running sync twice in a row must plan zero writes the second time. This
    is the main test: `plan(read(apply(plan(x))))` is empty.

### G. What union cannot do

43. **Removals come back.** If the user un-watches an episode or removes an entry on one
    tracker, the next sync adds it back from the others. With pure union, the only way to
    remove something is to remove it everywhere. The fix is a three-way merge: keep a
    snapshot of the last sync, and treat "present in the snapshot, gone now" as a deliberate
    removal. The snapshot must be keyed by account, because a different account on the same
    tracker makes it invalid. Decision needed, see below.

### H. What each tracker syncs

44. **Some users keep a tracker for some kinds only.** Example: Simkl for movies and TV, but
    not anime. The sync panel has, per tracker, a toggle for each kind it can take: movies,
    TV, anime. The kinds a tracker can take come from its `family` in `TRACKER_INFO`
    (AniList and MAL: anime only; Trakt and Simkl: all three), so no tracker name is
    special-cased. All kinds are on by default. The choice lives in `sync` storage and goes
    into the backup (`lib/portability`).
45. **A kind that is off is off both ways.** Those entries are not read as a source and not
    written as a target. Example: with anime off for Simkl, an anime the user rated on Simkl
    long ago is not copied to AniList, and AniList anime is not copied to Simkl.
46. **Who decides the kind.** It is decided once per matched group: anime if the crosswalk
    knows the item or any tracker lists it as anime (a Simkl `anime` entry, any AniList or
    MAL entry). This matters because Simkl files anime under `anime` even when we send it as
    a TMDB show, so "Simkl without anime" must also skip anime that reached Simkl from Trakt.
    An item Simkl lists under `shows` that the crosswalk calls anime counts as anime.
47. **Scrobbling is a separate control.** This setting is for sync only. Which trackers a
    live watch goes to stays the per-recipe toggle set (constraint #1), so a user who does not
    want anime on Simkl also turns Simkl off on their anime recipes.

## Decisions (settled 2026-09-28)

1. **Removals (item 43).** Pure union in v1, plus a per-item "ignore" list so the user can
   keep one item out of sync. The three-way merge is a later phase.
2. **Status conflicts (item 19).** The most recently updated entry wins. The preview shows
   each one so the user can flip it.
3. **Trakt status (item 17).** Trakt is left out of status in v1. It syncs watched history
   and ratings only.
4. **Backfill dates (item 11).** The source's date when known, else Trakt's `released`
   option (the air date).
5. **Private and adult entries (items 28, 29).** Skipped by default, with an option to
   include them.
6. **What each tracker syncs (section H).** A per-tracker choice of kinds.
7. **A main list per kind (added 2026-09-28).** Pure union re-adds stale entries: Akira is
   plan to watch on an old MAL list, removed from AniList, and union copies it back to AniList.
   So each kind can have a main list. With one:
   - Only the main list is a source. The others copy it; nothing flows back.
   - An entry the main list does not have is REMOVED from the others. Only list entries: a
     seasoned list (Trakt history, or a whole Simkl show holding other cours) is never
     removed, and the plan says so (`history_kept`).
   - A copy's progress still never goes down, and a completed entry is never moved. Where a
     copy is further than the main list, the plan says so (`ahead`) and leaves it.
   - Ratings: the main list fills empty ones; a copy's own different rating is kept
     (`rating_kept`).
   - The main list's status wins, however old (no "most recent wins").
   - If the main list was not read, nothing of that kind is planned (`main_missing`). A union
     fallback would bring back what the user removed.
   - Turning a kind off for its main tracker clears the main list for that kind, on screen.
   - The preview has its own Removals tab, and a "Left as is" tab for the notices.
   Kinds with no main list stay a union. Section G (remembering the last sync) is still the
   later fix for removals in union mode.

## Phases

1. **Read and preview only.** `readList()` for all four trackers, matching, the planner, and
   the preview. No writes. This alone shows how well matching works on a real account.
2. **Apply.** `applyBatch()`, the chunked runner, resume, and cancel.
3. **Later:** a daily run with cheap change checks (Trakt `/sync/last_activities`, Simkl
   `/sync/activities`, AniList `updatedAt`), and the three-way merge if chosen.

## Phase 1 status (built on `feat/list-sync`, previewed on the owner's real accounts)

What is built:

- `lib/sync/types.ts`, `score.ts`, `plan.ts`: the pure planner, with tests for sections A to
  H, and a convergence test (apply the plan, plan again, expect no writes).
- `lib/trackers/<tracker>/list.ts`: one reader per tracker, each a pure normalizer (Zod, a bad
  item is dropped) plus a fetch in that tracker's `client.ts`.
- `lib/sync/run.ts`: the preview is a job. `listSyncStart` returns at once, the job saves
  each step to `local:list_sync_job` with a beat every 10 s, and Options watches it. A running
  job with no beat for 30 s was stopped by the browser, and the pane says where. (A first try
  ran the whole read inside one message, and a stopped worker gives the page no answer.)
- Options: a "List sync" pane (`ListSyncView`), with the per-tracker kind switches, the private
  and adult switches, the preview, and "keep out of sync" per item. Gallery states added.
- The choices are in `sync:list_sync_settings` and in the backup file.

What the reads cost, per preview:

- Trakt: up to 5 GETs (`/sync/watched/shows`, `/sync/watched/movies`, `/sync/ratings/{shows,seasons,movies}`), fewer when shows or movies are off.
- AniList: 1 + one per 500 entries (`Viewer`, `MediaListCollection` in chunks, custom lists skipped).
- MAL: one per 1000 entries (`/users/@me/animelist`), one after the other.
- Simkl: 1 to 3 of the daily quota, one per type the chosen kinds need (`/sync/all-items/shows` with episodes, `/anime` and `/movies` as summaries). One request for all three was slow on a big library.

Found while building:

- **Trakt keeps ratings apart from history.** An item rated but not watched is still an entry
  (nothing watched). Without that, a rating written to Trakt would not be read back, and the
  next sync would write it again.
- **Trakt's own gaps stay.** Trakt watched 1, 2, 5 gives AniList progress 5 (the scrobble
  rule), but Trakt is not filled with 3 and 4 from its own max. Only a cour tracker's count, or
  another list's real episodes, adds episodes to Trakt.
- **A cour score maps to a Trakt rating only when they rate the same thing:** the show when
  the show is one cour, the season when the cour is that whole season, else nothing
  (`Animap.ratingTarget`).
- **A MAL entry finds its AniList group** through an AniList entry's `idMal`, else the
  crosswalk. A MAL entry that is in neither can reach only Simkl.
- **The ignore list is in `sync` storage**, which has an 8 KB per-item limit. That is about
  400 ignored items. If it grows past that, move it to `local`.
- **Crosswalk user overrides** (`animapOverrides`, the fix-match pins) are not used by the
  planner yet. Phase 2 should apply them before the Fribb rows, as scrobbling does.
- **Anime titles that Simkl files under `shows`** (not `anime`) are handled like Trakt: by
  their tmdb id through the crosswalk.

## Handover for phase 2 (2026-09-28)

Phase 1 is done and works on the owner's real accounts (Trakt, AniList, MAL, Simkl). The branch
is `feat/list-sync`, 7 commits ahead of `main`, **not pushed**, no PR yet. Every commit passes
`pnpm lint`, `tsc`, `pnpm test`, and `pnpm build`. Start phase 2 on the same branch.

### Where things are

| What | File |
|---|---|
| Types (entries, settings, writes, plan, notices) | `lib/sync/types.ts` |
| The pure planner (union, main list, notices) | `lib/sync/plan.ts` (+ `plan.test.ts`) |
| Score scales and "same on the target's scale" | `lib/sync/score.ts` |
| The preview job (storage-backed, beats, versioned) | `lib/sync/run.ts` (+ `run.test.ts`) |
| Readers, one per tracker (pure normalizer + fetch) | `lib/trackers/<tracker>/list.ts`, fetch in its `client.ts` |
| The seam | `TrackerService.readList(kinds)` in `lib/trackers/service.ts` |
| Crosswalk lookups for sync | `Animap.has / anilistForMal / malForAnilist / anilistIds / ratingTarget` |
| Storage | `sync:list_sync_settings`, `local:list_sync_job` (`lib/storage.ts`) |
| Messages | `listSyncStart` (background returns at once; progress via storage) |
| The pane | `lib/ui/kit/ListSyncView.tsx` (+ render test), wired in `entrypoints/options/App.tsx` |
| Gallery states | `entrypoints/gallery/list-sync.tsx` |
| Backup | `lib/portability/backup.ts` carries `listSync` (kinds, main, private, adult, ignore) |

Rules that bit during phase 1:

- **Bump `SYNC_JOB_VERSION`** (`run.ts`) whenever `SyncJob`, `SyncPreview`, `SyncPlan`, or
  `SyncWrite` changes shape. A saved preview from an older build blanked the pane once.
- **Reload the extension after a build.** A stale background gave an instant "No response".
- The planner describes INTENT (`SyncWrite`). Turning it into API calls is phase 2's job.

### Phase 2: apply

1. **An "Apply" button** on the preview, with a confirm that repeats the totals, removals
   first. Apply runs the plan the user saw: re-read and re-plan if the preview is older than a
   few minutes (edge case 36), and show the new plan if it changed.
2. **`applyBatch()` per tracker** on `TrackerService` (next to `readList`), taking that
   tracker's `SyncWrite`s:
   - **Trakt:** `POST /sync/history` (episodes, movies; batch many items per call) and
     `POST /sync/ratings`. Never removes (`removesEntries` is false for it). Check
     `not_found` in each reply.
   - **Simkl:** `POST /sync/history` (episodes; `anime` key for a cour target with
     `target.anime`), `POST /sync/ratings`, `POST /sync/add-to-list` (status),
     `POST /sync/history/remove` (removal; it also clears the rating). 1 POST per second,
     batch everything, check `not_found`. Not the scrobble endpoints, so no 20 s lock.
   - **AniList:** `SaveMediaListEntry(mediaId, progress, status, repeat, scoreRaw)`, one per
     entry. **Removal needs `DeleteMediaListEntry(id)` with the LIST ENTRY id, not the media
     id.** The reader does not read it yet: add `id` to the `MediaListCollection` entries
     query and carry it on the entry (`EntryBase` or the cour shape).
   - **MAL:** `PATCH /anime/{id}/my_list_status` per entry, and
     `DELETE /anime/{id}/my_list_status` for a removal. Space calls 1 to 2 s; on 403 stop MAL
     and report "resume later", never retry in a loop.
3. **Read before each cour write** (AniList, MAL): `progress = max(fresh remote, planned)`,
   and skip if the entry became COMPLETED (edge case 35). Same rule as scrobbling.
4. **Dates on backfilled watches** (decision 4): the source's date when known, else Trakt's
   `released`. The planner does not carry dates yet: add them to the `episodes`/`movie`
   writes (the entries already have `updatedAt`; per-episode dates need Trakt history or
   Simkl `episode_watched_at=yes`).
5. **The runner:** a job like the preview (`run.ts`): chunks, the position saved after each
   chunk, beats, cancel, and a summary. On resume, re-read the tracker whose chunk was in
   flight before sending again (a history write sent twice is a duplicate play, edge case 34).
6. **Rating conflicts:** let the user pick a value in the "Trackers disagree" tab (today they
   are left alone).
7. **Crosswalk overrides:** apply `animapOverrides` (the user's fix-match pins) before the
   Fribb rows in the planner, as scrobbling does. Not done in phase 1.
8. **Tests:** apply is where convergence matters for real. After apply, a new preview must
   show no changes (the planner test does this with a simulated apply; do it once live too).

### Before merge (still to do)

Move the facts that stay true into `docs/ARCHITECTURE.md` (a list sync section) and
`docs/TRACKERS.md` (the list read endpoints per tracker), delete this file, then PR and
squash-merge. Suggested PR title: "Sync your lists across trackers".

## Phase 2 status (built on `feat/list-sync`, not yet run on a real account)

What is built:

- **Apply runner** `lib/sync/apply.ts`: a job in `local:list_sync_apply`, like the preview.
  Trackers run side by side, in chunks each tracker sizes (`TrackerService.applyList`), with
  the counts saved after each chunk, beats, and Stop (`local:list_sync_cancel_at`, its own item
  so the job's saves never overwrite it).
- **No resume from a position.** To finish a stopped or cancelled apply, preview again and
  apply that. The planner diffs against what each tracker has now, so written items drop out
  and a Trakt or Simkl history write is never sent twice, not even the chunk in flight when the
  worker stopped (edge case 34). So a preview is applied once (`spent`), and only within 10
  minutes (`stale`, edge case 36). `applyBlock` is the one rule; Options shows the same answer.
- **Writers**, one `apply.ts` per tracker:
  - Trakt: one `/sync/history` and one `/sync/ratings` POST per 100 writes, 1.1 s apart.
    `watched_at` is the source date, else `"released"`. 429 and 420 stop Trakt. The rating
    cache is dropped after ratings.
  - Simkl: `/sync/history/remove`, `/sync/history`, `/sync/ratings`, per 250 writes. Anime goes
    under `shows[]` everywhere (Simkl's docs: `/sync/history/remove` ignores `anime[]`), with
    cour ids and top-level `episodes`. An anime entry's status rides in the history item
    (`status`), so there is no `/sync/add-to-list` call. An anime movie is sent as
    `status: "completed"`. No `watched_at` when the date is unknown (Simkl has no "released").
  - AniList: a fresh read of up to 25 entries (`Page.mediaList(mediaId_in)`), then one
    `SaveMediaListEntry` (with `scoreRaw`) or `DeleteMediaListEntry` per entry. The fresh read
    gives the list entry id, so the reader did not need it. 2.1 s apart; a 429 waits out
    `Retry-After` once, a second stops AniList.
  - MAL: `getMyListStatus` then PATCH or DELETE per entry, 1.5 s apart. A 403 stops MAL.
- **Read before write** (`lib/sync/merge.ts`, pure): progress `max(fresh, planned)`, a finished
  entry is never moved, a status goes in only if the entry still has the status the preview
  saw, a rating fills an empty one unless the user picked it, and nothing is rated that is not
  on the list.
- **Rating picks**: the "Trackers disagree" tab has a score picker per rating conflict
  (`local:list_sync_picks`). `withPicks` turns a pick into writes for every tracker that differs
  (`picked: true`, which replaces its rating). Conflicts carry `refs` for this.
- **Status picks**: the same tab has a status picker (no pick = the most recent wins). A status
  conflict carries `targets` (each cour tracker's entry, its status, and the progress and length
  it will have), and `withPicks` rewrites their `entry` writes. A picked status still follows
  the episodes: finished by sync = completed, "completed" needs every episode, progress > 0 is
  never "plan to watch". Picks are keyed `rating:<key>` / `status:<key>` (`pickKey`).
- **Crosswalk pins** in the planner: `withOverrides` (`lib/trackers/animap/overrides.ts`) folds
  `animapOverrides` into the Fribb rows. Only pins that name a TV season; a pin keyed
  `${tmdb}:` does not say movie or show, so it is left out. "Not on AniList" for a season
  drops it for MAL too (stricter than scrobbling, never looser).
- **Dates**: `episodes` / `movie` / `entry` writes carry `at`, the newest `updatedAt` of the
  sources that have watches.
- **Simkl rating mirror** is refreshed from each full Simkl read (edge case 27).
- **Planner fixes found while building**: Simkl keeps no rewatch count, so it gets no `repeat`
  write (it planned one on every run, never converging). A cour tracker gets a rating only
  where it has, or will get, an entry (rating an unlisted item adds it).
- **UI**: Apply bar with a confirm (removals first, in the bad-box tone), per-tracker progress
  with Stop, a summary with what failed, sticky table headers (`cardSolid` token). Gallery:
  stale, applying, applied (MAL stopped).

Still open for phase 2:

- **Run it once live** on the owner's accounts, then preview again: it must show no changes
  (convergence for real). Watch the Simkl quota line and MAL's 403.
- `/sync/history` for a Simkl anime entry with top-level `episodes` is from the docs, not yet
  seen live. Same for Trakt `watched_at: "released"` in a sync body.
- Firefox: the runner's beat is the same as the preview's; long MAL runs are unverified there.

## To verify against the live APIs

- The Simkl `/sync/all-items` shape for anime (are `anilist` and `mal` ids always there?). The
  documented example has them, as strings.
- AniList: several aliased mutations in one request, and how they count against the limit.
- Trakt free account item limits (watchlist, history).
- MAL list paging (`limit=1000`, `offset`) and its fields for `updated_at` and rewatch.
