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

1. **Read.** Each adapter gets an optional `readList()` that returns its whole list as
   normalized entries (ids, family, progress or watched set, status, rating, timestamps).
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

28. **Private entries.** An AniList entry marked `private` or hidden from status lists must
    not be copied to a public Trakt profile. Default: skip it and report it.
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

## Phases

1. **Read and preview only.** `readList()` for all four trackers, matching, the planner, and
   the preview. No writes. This alone shows how well matching works on a real account.
2. **Apply.** `applyBatch()`, the chunked runner, resume, and cancel.
3. **Later:** a daily run with cheap change checks (Trakt `/sync/last_activities`, Simkl
   `/sync/activities`, AniList `updatedAt`), and the three-way merge if chosen.

## To verify against the live APIs

- The Simkl `/sync/all-items` shape for anime (are `anilist` and `mal` ids always there?).
- AniList: several aliased mutations in one request, and how they count against the limit.
- Trakt free account item limits (watchlist, history).
- MAL list paging (`limit=1000`, `offset`) and its fields for `updated_at` and rewatch.
