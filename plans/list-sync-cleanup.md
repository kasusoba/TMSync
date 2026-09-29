# Plan: list sync cleanup (small fixes and file structure)

Status: IN PROGRESS on `feat/list-sync-auto` (PR #40), not a separate PR (owner, 2026-09-29).
Part A done. A working plan, not a doc. Delete this file before the PR merges. Anything that stays true goes into `docs/ARCHITECTURE.md` section 7.

## Start here

1. Wait for PR #40 (`feat/list-sync-auto`) to merge. All code named below is in that PR.
2. Then bring this branch up to date: `git checkout refactor/list-sync-cleanup && git merge main`
   (this branch holds only this file, so there is nothing to conflict).
3. Do part A first (behavior fixes, one commit each, each with a test). Then part B (no behavior
   change). Run `pnpm lint`, `./node_modules/.bin/tsc --noEmit` (in `packages/extension`),
   `pnpm test`, and `pnpm build` after every step.

Where this came from: a code review of PR #39 and #40 on 2026-09-29. Its four serious bugs are
fixed in PR #40 (`ce3860e`, `57e0a97`, `4fa5da9`, `b84b594`). This file holds what was left.

## Rules for this work

- `CLAUDE.md` applies in full. The ones that matter most here: the planner stays pure (no I/O),
  the crosswalk stays out of `extract()`, the background keeps no state in memory, and nothing
  retries in a loop.
- Part B changes no behavior. The existing tests must pass without edits, other than import
  paths. If a test needs a logic change, stop: that is a behavior change.
- Keep the "convergence" property: apply a plan, plan again, get no writes
  (`plan.test.ts`, `plan-base.test.ts`).
- No em or en dashes anywhere. Commit messages and the PR use Simplified Technical English.

## A. Small fixes (behavior)

A1. **Disconnect can fail on a storage error.** `entrypoints/background.ts`, the
`disconnectTracker` handler clears `listSyncCache` and calls `forgetBase` before
`getService(data).disconnect()`, with no catch. If a storage call throws, the account is never
disconnected. Fix: add `.catch(() => {})` to both, as the `connectTracker` handler does. Or
disconnect first, then clear.

A2. **Two previews can start at once.** `lib/sync/run.ts`, `beginPreview` reads `listSyncJob`,
checks `jobAlive`, then writes a new job. An alarm and a click at the same time both pass the
check. Both jobs read every list (two Simkl reads cost quota twice) and write the same storage
item. Fix idea: write a claim with a random token, read it back, and go on only if the token is
still ours. Or run the check and the write under `navigator.locks.request("tmsync-list-sync", ...)`
(available in MV3 service workers and Firefox). The lock is simpler. Test with two concurrent
calls in a fake browser: exactly one gets a job.

A3. **The automatic run replaces the preview the user is reading.** `lib/sync/auto.ts`,
`runAuto` calls `beginPreview(true)`, which overwrites `listSyncJob`. If the user has a manual
preview open (with picks), it disappears, and the new preview is "spent" (the automatic apply
used it). Options, pick one with the owner:
  - Skip the automatic run while a manual preview is less than `APPLY_FRESH_MS` old and not
    applied yet (save `state: "skipped"`, note "A preview was waiting."). The simplest option.
    **Chosen by the owner (2026-09-29).**
  - Or keep the automatic job in its own storage item. More code, and the pane needs two jobs.

A4. **`startApply` drops errors.** `lib/sync/apply.ts`, `void beginApply(...)` has no catch. If
the first `listSyncApply.setValue` throws, the rejection is unhandled and the pane shows nothing.
Fix: `.catch` that saves a failed job (`state: "failed"`, `error`), like `runPreview` does.

A5. **Big spreads.** `lib/sync/run.ts`, `entries.push(...list.entries)`, and
`anilist/client.ts` / `mal/client.ts` push pages with spread. A spread of more than about 100k
arguments throws a RangeError. Not likely with real lists (MAL pages are 1000), but a loop or
`concat` costs nothing. Low priority.

Not in scope here: the Simkl `date_from` question. It is live check 1 in
`plans/list-sync-phase3.md` (PR #40), and must be answered before PR #40 merges.

## B. Structure (no behavior change)

Do these in this order. Each is one commit.

B1. **Split the planner.** `lib/sync/plan.ts` is about 1,200 lines. `planSync` is one closure
that holds `planWestern`, `planCour` (with `courTarget`, `seasonedTarget`, `removeFromCopies`
inside it), `fillRatings`, `ratingNotices`, and `push`, all sharing captured state. Target:

```
lib/sync/plan/
  index.ts      planSync (builds the context, runs the groups), re-exports the public API
  context.ts    PlanContext: input, settings, scale(), taking, mainFor(), the base and "now"
                indexes, unread + unreadHas, atBase / listedAtBase / hasNow, removedSince,
                unratedSince, mainMissing, and the output arrays (items, skips, conflicts,
                notices, removed) with push()
  group.ts      groupSeasoned, the cour groups (courGroup, anilistOf), the seasoned to cour
                parts (the crosswalk walk now at the end of planSync)
  western.ts    planWestern(ctx, members, kind)
  cour.ts       planCour(ctx, key, group), with courTarget, seasonedTarget, removeFromCopies
  ratings.ts    fillRatings, ratingNotices
  picks.ts      withPicks
  summary.ts    summarize
  util.ts       syncKindsFor, takesKind, removesEntries, stateOf, normStatus, courCount,
                sharedKeys, mergeIds, hasEpisode, sortEps
```

Keep `lib/sync/plan.ts` as a one-line re-export for one step, so imports keep working, then
update the imports (`run.ts`, `apply.ts`, `auto.ts`, options `App.tsx`, `ListSyncView.tsx`, the
gallery, tests) and delete it. Move `plan.test.ts` and `plan-base.test.ts` next to the new files
only if it helps. They test through `planSync`, so they can stay as they are.

B2. **One job helper for the preview and the apply.** `run.ts` and `apply.ts` repeat the same
code: the save queue (`saving = saving.then(...)`), the beat interval with
`getPlatformInfo()`, `jobAlive`, and the version check (`readJob` / `readApply`). Make
`lib/sync/job.ts`:

```ts
export function jobRunner<J extends { beatAt: number }>(item: StorageItem<J | null>, start: J) {
  // returns { get(): J, save(patch): Promise<void>, stop(): Promise<void> }
  // save merges the patch, sets beatAt, queues the write; a timer beats every BEAT_MS.
}
export function jobAlive(...) // moved from run.ts
export function versioned<J extends { v: number }>(v: number) // makes readJob / readApply
```

Then rename `run.ts` to `preview.ts` (it is the preview job; "run" is also the name of the
tracker `applyList.run`).

B3. **File names that say what the file holds.**
  - `pace.ts` holds the writer helpers (`sleep`, `targetKey`, `byTarget`, `toTen`, `outcomes`,
    `inNotFound`). Rename to `write-util.ts`.
  - `read.ts` holds the reader helpers (`ms`, `num`, `parseEach`, `newest`). Rename to
    `read-util.ts`. Note `plan.ts` imports `newest` from it.
  - `cache.ts` is the saved-list read cache, easy to confuse with the base. Rename to
    `list-cache.ts`.
  - `base.ts` + `base-store.ts` stay as they are (owner, 2026-09-29).

Imports to update: every `lib/trackers/<tracker>/list.ts` and `apply.ts`,
`lib/trackers/service.ts`, `lib/storage.ts` (type imports), and the tests. Update the file names
in `docs/ARCHITECTURE.md` section 7 and `docs/TRACKERS.md` ("List sync: reads and writes", and
the "Adding a tracker" checklist step 8).

B4. **Split `ListSyncView.tsx`.** About 1,300 lines, twice the next biggest kit view. Target:

```
lib/ui/kit/list-sync/
  ListSyncView.tsx    the pane (props stay the same)
  cards.tsx           CardTitle, SettingRow, AutoLine, TrackerCards
  ApplyBar.tsx        ApplyBar, BLOCK_LABEL
  ApplyProgress.tsx   ApplyProgress, APPLY_STATE
  PreviewResult.tsx   PreviewResult and its tabs
  ChangesTable.tsx    ChangesTable, Th, ShowMore, Empty
  labels.ts           KIND_LABEL, STATUS_LABEL, SKIP_LABEL, NOTICE_LABEL, FROM_LABEL, READ_LABEL
```

Move `describeWrite` and `describeState` (pure, no UI) to `lib/sync/describe.ts` and move their
tests from `ListSyncView.test.tsx` to `lib/sync/describe.test.ts`. Keep `lib/ui/kit/ListSyncView.tsx`
as a re-export only if other code imports it by that path; else update the imports (options
`App.tsx`, `entrypoints/gallery/list-sync.tsx`). Check the gallery still renders every state
(`pnpm dev`, then `chrome-extension://<id>/gallery.html`). The UI rules in `CLAUDE.md` ("UI &
visual design") apply: reuse the kit, change no look.

B5. **A `useListSync()` hook for the options page.** `entrypoints/options/App.tsx` has about
200 lines of list sync state, watchers, and handlers (search for `syncSettings`, `syncJob`,
`syncApply`, `syncPicks`, `autoRun`). Move them to `entrypoints/options/useListSync.ts`, which
returns the props `ListSyncView` needs. `App.tsx` then only passes them on.

## Done when

- Part A: each fix has a test that fails without it.
- Part B: `git diff main --stat` shows moves and import edits, the test count is the same as
  before part B, lint, tsc, tests, and build pass, and the gallery looks the same.
- `docs/ARCHITECTURE.md` section 7 and `docs/TRACKERS.md` name the new files.
- This file is deleted. The PR title is for users, for example "Fix small list sync issues"
  (part B alone gives no release note line; put it in the same PR as part A, or title it plainly).
