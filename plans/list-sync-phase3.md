# Plan: list sync, phase 3 (automatic sync and remembered removals)

Status: not started. PR #39 (phases 1 and 2) is merged to `main` (2026-09-28, no release cut
yet). **The owner's priority is the daily run (A).** Start the next session by asking the five
decisions below, then build in the order under "Phases". A working plan, not a doc. It lives only on `feat/list-sync-auto`. Before the
PR merges, the facts that stay true move into `docs/ARCHITECTURE.md` (section 7) and
`docs/TRACKERS.md` ("List sync: reads and writes"), and this file is deleted.

Phases 1 and 2 (preview and apply) are done and were tested live on the owner's four accounts
(2026-09-28). How they work is in `docs/ARCHITECTURE.md` section 7. The old working plan, with all
47 edge cases and the settled decisions, was squashed away with PR #39. Get it back from GitHub's PR
ref: `git fetch origin pull/39/head:pr39 && git show aee1d23^:plans/list-sync.md`.

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

- A `browser.alarms` alarm (constraint #4: no timers in memory), for example every 24 h, set when
  the user turns auto sync on and cleared when off. The handler runs: cheap checks, then a preview
  job, then an apply job, all the existing jobs.
- **What it may apply on its own** (decision needed, see below). Proposal: only what cannot lose
  anything. Additions (episodes, movies, new entries, progress up) and empty-rating fills go in.
  Removals, conflicts, and status changes wait for the user.
- **Telling the user.** Proposal: the toolbar badge text (`browser.action.setBadgeText`, no new
  permission) shows how many changes wait for review, and the pane shows the last automatic run.
  `notifications` would be a new install permission with a warning, so avoid it.
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

## Decisions needed (ask the owner)

1. **What an automatic run applies**: additions only (proposal), or everything except removals, or
   everything?
2. **How often**, and whether the user can pick (daily, every 12 h, weekly).
3. **Three-way merge scope**: entries only, or also un-watched episodes and removed ratings? (An
   episode un-watched on Trakt would then be un-watched on Simkl, and lowered on AniList and MAL,
   which breaks "progress never goes down". Proposal: entries and ratings only.)
4. **Badge or notification** for "changes wait for review".
5. Is `unlimitedStorage` acceptable if the snapshot needs it?

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
2. The daily alarm with additions-only apply and the badge (A).
3. The three-way merge (C) behind a setting, then on by default once it has run clean for a while.
