# Plan: list sync, phase 3 (automatic sync and remembered removals)

Status: ALL THREE PHASES BUILT on `feat/list-sync-auto` (2026-09-28), not yet tested live. The
lasting facts are folded into `docs/ARCHITECTURE.md` section 7 and `docs/TRACKERS.md` ("List sync:
reads and writes"). Before the PR merges: run the live checks at the end of this file, then delete
this file. A working plan, not a doc.

- Phase 1, change checks + saved lists: `370fe83`.
- Phase 2, daily automatic sync: `2f4fd5a`.
- Phase 3, remembered removals: `fbede9f`.

## Goal

1. **Automatic sync.** List sync runs on its own, about once a day, without the options page.
2. **Cheap checks.** Before reading whole lists, ask each tracker if anything changed since the
   last sync. Nothing changed = no read, no plan, no quota.
3. **Remembered removals (three-way merge).** Keep a snapshot of the lists after the last sync.
   "In the snapshot, gone now" is a deliberate removal, so union mode stops bringing it back.

## What exists to build on

| What | Where |
|---|---|
| Preview job (read + plan, in storage, beats) | `lib/sync/run.ts` `startPreview` |
| Apply job (chunks, stop, per-entry progress) | `lib/sync/apply.ts` `startApply`, `applyBlock`, `applyQueues` |
| Pure planner, picks | `lib/sync/plan.ts` `planSync`, `withPicks` |
| Read before write (AniList, MAL) | `lib/sync/merge.ts` |
| Readers and writers | `lib/trackers/<tracker>/list.ts`, `apply.ts`; seam `readList` / `applyList` in `lib/trackers/service.ts` |
| Alarms per tracker | `TrackerService.alarms` (see Simkl's held stop) |
| Settings | `sync:list_sync_settings` (in the backup), `local:list_sync_picks` |
| The pane | `lib/ui/kit/ListSyncView.tsx`, gallery `entrypoints/gallery/list-sync.tsx` |

Rules that bit before: bump `SYNC_JOB_VERSION` / `APPLY_JOB_VERSION` when a saved shape changes;
reload the extension after a build; the planner describes intent, the writers make API calls.

## Proposal

### A. The daily run

- A `browser.alarms` alarm (constraint #4: no timers in memory), every 24 h, set when the user
  turns auto sync on (off by default) and cleared when off. The handler runs: cheap checks, then a
  preview job, then an apply job, all the existing jobs.
- **What it applies on its own** (decision 1): additions only. Episodes, movies, new entries,
  progress up, and empty-rating fills go in. Removals, conflicts, and status changes wait for the
  user.
- **Telling the user** (decision 4): the toolbar badge text (`browser.action.setBadgeText`, no new
  permission) shows how many changes wait for review, and the pane shows the last automatic run.
- On a timer, if Simkl's activity call fails, skip Simkl for that run. Never fall back to a full
  read (a manual read may).
- A running manual job blocks the automatic one, and the other way round (`jobAlive`).
- A preview older than 10 minutes cannot be applied (`applyBlock`), so the automatic run must plan
  and apply in one go.

### B. Cheap change checks

Store, per tracker, the last activity stamp seen at the last successful sync
(`local:list_sync_seen`). Skip a tracker's read when its stamp did not move. If no tracker moved,
the run ends.

| Tracker | Check | Notes |
|---|---|---|
| Trakt | `GET /sync/last_activities` | per type: episodes watched, movies watched, ratings |
| Simkl | `GET /sync/activities` | Simkl's rule for timed sync: check this first, then `/sync/all-items?date_from=` for the delta only |
| AniList | `Page(perPage: 1) { mediaList(userId, type: ANIME, sort: UPDATED_TIME_DESC) { updatedAt } }` | to verify: sort name and cost |
| MAL | `/users/@me/animelist?sort=list_updated_at&limit=1&fields=list_status{updated_at}` | to verify: sort support |

A skipped tracker still has to take part in the plan (as a target and a source). So the run needs
its list without reading it: see C.

### C. The snapshot (serves both B and the three-way merge)

- After a successful apply, re-read (or patch) and save each tracker's normalized entries
  (`ListEntry[]`) as the snapshot: `local:list_sync_base`, keyed by tracker AND account id (a
  different account on the same tracker makes it invalid). Account ids: Trakt `/users/settings`,
  AniList `Viewer.id`, MAL `/users/@me`, Simkl `/users/settings`.
- **B uses it** as the list of a tracker whose stamp did not move, and Simkl's `date_from` delta is
  merged into it instead of a full read.
- **Three-way merge.** `planSync` gets an optional `base`. In union mode, an entry (or a watched
  episode, or a rating) that is in the base but gone now on one tracker, and unchanged on the
  others since the base, is a removal: plan it on the others instead of adding it back. Changed on
  both sides = a conflict for the user. The same "never remove Trakt history" rule holds.
- **Size.** `storage.local` is 10 MB without `unlimitedStorage`. A big Trakt library (thousands of
  shows with episode sets) can be MBs. Measure on the owner's account first. Options: store episode
  sets compactly (ranges), or ask for `unlimitedStorage` (no warning in Chrome, check Firefox).
- A snapshot is only valid after a CLEAN apply (every tracker done, no failures). Otherwise keep the
  old one, or a failed write looks like a removal next time.

## Decisions (settled with the owner, 2026-09-28)

0. **Auto sync is optional and off by default.** One switch in the List sync pane. The alarm
   exists only while the switch is on; turning it off clears the alarm.
1. **An automatic run applies additions only**: new entries, watched episodes and movies,
   progress up, and a rating on a tracker that has none. Removals, conflicts, and status changes
   wait for the user. Nobody watches an unattended run, so it only makes changes that cannot lose
   anything.
2. **Once a day, no frequency setting.** Scrobbling already records watches live, so the run only
   catches edits made on the tracker sites. The manual Sync button covers "now". Simkl cost per
   run: 1 activity call plus 0 to 3 reads.
3. **Remembered removals cover entries and ratings only.** Un-watched episodes are not carried
   over: that would lower progress on AniList and MAL.
4. **The toolbar badge** (`browser.action.setBadgeText`, no new permission) shows how many changes
   wait for review. No notifications.
5. **No `unlimitedStorage` for now.** Measure the saved lists on the owner's account first, then
   store episode sets as ranges if needed. Ask for the permission only if that is still too big
   (Chrome allows it as optional; Firefox is unverified). The saved lists also serve manual sync,
   so every user has them, not only those with auto sync on.

## Edge cases to plan for

1. The worker is asleep when the alarm fires: alarms wake it. A missed alarm (browser closed) fires
   once on the next start (`chrome.alarms` catches up once, not once per missed period).
2. A token expired overnight: that tracker is `not_connected` in the read; the run goes on without
   it and says so. A snapshot is not updated for a tracker that was not read.
3. Simkl quota: a daily run costs `/sync/activities` (1) plus a delta read (0 to 3) plus writes.
   Never a full read on a timer (Simkl's rule).
4. MAL's 403 on an automatic run: stop MAL, keep going, and try again on the next run. Never a
   retry loop.
5. The user changes the kinds, main lists, or ignore list: the snapshot's meaning changes. Proposal:
   drop the base on any settings change that adds a kind or a tracker.
6. Scrobbling during an automatic run: already handled by read before write on the cour trackers,
   and by the diff on Trakt and Simkl.
7. Firefox: alarms and long jobs in its background page (the beat is untested there).
8. Two browsers with TMSync on the same accounts: both run daily. The diff makes the second run
   plan nothing, but they could overlap. Acceptable, since every write is safe on its own.

## Phases

Why the checks come before the alarm: Simkl asks apps that sync on a timer to check
`/sync/activities` first and read only the delta (`date_from`). A daily full read would break that
rule. So the smallest daily run is: checks (B), then the alarm (A). The snapshot can start as a
plain read cache for the trackers that did not change.

1. Cheap checks + the snapshot as a read cache (B, C without the merge). Manual sync gets faster.
   **Built** (see "Phase 1 as built").
2. The daily alarm with additions-only apply and the badge (A).
3. The three-way merge (C) behind a setting, then on by default once it has run clean for a while.

## Phase 1 as built

- `lib/sync/cache.ts`: `ListCache` (stamps + entries, versioned by `LIST_CACHE_VERSION`), `ListRead`
  (what `readList` returns now), and pure helpers. Saved per tracker in
  `local:list_sync_cache_<tracker>`. The runner passes the saved list to `readList(kinds, saved)`
  and saves the returned `cache`. A save that fails (too big) removes the old one.
- Dropped on connect and disconnect (background `connectTracker` / `disconnectTracker`), so a
  different account never reuses it. No account id call needed. Backups do not carry it.
- The stamp is always read BEFORE the list, so a change during the read moves it past the saved
  stamp and the next read sees it.
- **Trakt**: `/sync/last_activities` `all`, per part (shows, movies). Trakt's docs do not say which
  field a history or rating removal moves, so `all` is used: it may read when nothing in the list
  moved (a comment, a watchlist change), but never misses a change.
- **Simkl**: `/sync/activities`, per type (`tv_shows`, `anime`, `movies`). Unmoved = no read. A
  null stamp = the type never had activity, so it is empty and not read. Moved with
  `removed_from_list` unmoved = `date_from` delta (the saved stamp, sent as Simkl returned it),
  merged by Simkl id. `removed_from_list` moved = full read of that type (a delta never reports
  removals; Simkl suggests an `ids_only` refetch and diff, a possible later saving). If the activity
  call fails, everything is read in full and no stamps are saved.
- **AniList and MAL have no check, by choice.** Neither has an activity endpoint. The "newest
  `updatedAt`" query in the table above misses a deleted entry, and a light read that catches
  deletions costs about as much as the full read (AniList: one collection query; MAL: pages of
  1000). Neither has a quota. So they always read.
- The tracker cards say "No changes since the last read" or "Read only what changed".
  `SYNC_JOB_VERSION` is 6 (`TrackerRead.from`).
- Sources (2026-09-28): api.simkl.org/guides/sync and /api-reference/simkl/get-activities (the
  Apiary docs are frozen), docs.trakt.tv/reference/getsynclastactivities.

### To check live

1. Simkl delta: does a `shows` item in a `date_from` delta carry ALL its watched episodes (with
   `extended=full&include_all_episodes=yes`)? The merge replaces the saved item, so a partial item
   would drop episodes. Test: mark one episode on simkl.com, preview, compare the episode count.
2. Simkl: an empty delta body parses (handled: empty text reads as `{}`).
3. Size: the saved Trakt list on the owner's account (`chrome.storage.local.getBytesInUse`).
4. Trakt: a second preview right after a first shows "No changes since the last read".

## Phases 2 and 3 as built

- Automatic sync: `lib/sync/auto.ts` (`additionsOnly`, `runAuto`, `syncAutoAlarm`,
  `showAutoBadge`). `beginPreview` / `beginApply` are the awaitable jobs; the messages still return
  at once. `readList` got a `timed` flag (Simkl refuses a full read on a timer).
- Remembered removals: `lib/sync/base.ts` (pure), `lib/sync/base-store.ts` (storage),
  `planSync({ base })`, the `unrate` write in all four writers (`merge.ts` for AniList and MAL).
- Deviation from the plan: the base stores id keys + rated flags, not whole `ListEntry` values, so
  no range compaction and no `unlimitedStorage` are needed.
- Deviation: when a list added an item since the base while another removed it, the add wins
  (it is added back). No new conflict type.

### More to check live (phases 2 and 3)

5. Turn auto sync on: the alarm fires a minute later, the pane shows "Last automatic sync", and the
   toolbar shows a count only if something waits. Opening the pane clears the count.
6. Firefox: the alarm and the toolbar count (`browserAction`, `setBadgeText` with a tab `null`).
7. Remember removals: with a clean sync done, remove an anime from AniList, preview: MAL and
   Simkl anime get "remove", Trakt gets a "history kept" notice. Clear a rating on one list,
   preview: the others get "remove rating".
8. Unrate on each tracker actually clears: Trakt and Simkl `/sync/ratings/remove`, AniList and
   MAL score 0.
