# Plan: list sync statuses for Trakt and WeTrakr, and remembered misses

Branch `feat/wetrakr` (PR #50). Delete this file in the last step.

## Decisions (settled with the owner, 2026-10-01)

- Trakt statuses: the watchlist is "plan to watch" (movies and shows), the dropped list
  (`/users/hidden/dropped`, shows only) is "dropped". Trakt has no other status.
- WeTrakr statuses: shows `planning`, `watching`, `waiting`, `watched`, `paused`, `dropped`.
  Movies `planning`, `watched`, `dropped`. `watching` and `waiting` both read as CURRENT.
- Remembered misses: an item or an episode a tracker answered `not_found` for is remembered per
  tracker and item. Later previews do not plan it again and list it under Skipped ("not on
  Simkl"). A memory entry expires after 30 days (trackers add titles), and connecting the
  tracker again clears its memory.

## Status rules

- Statuses use `CourStatus`. Each tracker says per kind which statuses it can HOLD (read) and
  which it can be GIVEN (write), in one table next to `TRACKER_INFO`:

  | Tracker | movie: holds / given | tv (and anime show): holds / given |
  |---|---|---|
  | Trakt | PLANNING / PLANNING | PLANNING, DROPPED / PLANNING, DROPPED |
  | WeTrakr | PLANNING, COMPLETED, DROPPED / PLANNING, DROPPED | all but REPEATING / PLANNING, CURRENT, PAUSED, DROPPED |
  | Simkl | PLANNING, COMPLETED, DROPPED / PLANNING, DROPPED | all but REPEATING / PLANNING, CURRENT, PAUSED, DROPPED |

  COMPLETED is never given to a seasoned or western entry: it comes from watches (a bare
  WeTrakr `watched` or Simkl `completed` would mark every episode watched).
- Western desired status: the most recent status among the sources (`updatedAt`, which a
  watchlist, drop, or status date moves). PLANNING with a watch becomes CURRENT. A target gets
  the desired status only when it can be given it and its own differs (CURRENT vs
  waiting is equal). A disagreement is a status conflict, as for anime, and a pick wins.
- Leaving a status: a target that holds PLANNING and gets CURRENT, PAUSED, or DROPPED loses
  it (Trakt: watchlist remove; WeTrakr and Simkl: the new status replaces it). A Trakt show
  that holds DROPPED and gets CURRENT or PAUSED is undropped. A watched movie leaves PLANNING
  on every tracker that holds it.
- Main list: unchanged. Trakt and WeTrakr still cannot be a main list.
- Anime: a seasoned show status maps to a cour only when the crosswalk maps the TMDB show (or
  movie) to exactly one cour. A multi-cour show gives and takes no status.
- Auto sync: a status that comes with progress stays automatic. Other status changes wait for
  the user, as now.

## Steps (one commit each)

1. Remembered misses: storage, record on apply, planner skip `not_on_tracker`, UI label, docs.
2. Status table and readers: Trakt watchlist and dropped, WeTrakr planning list and show and
   movie statuses on entries.
3. Western planner statuses (and conflicts for movie and tv), with tests.
4. Anime: seasoned status for single-cour shows and anime movies, with tests.
5. Writers: Trakt watchlist and dropped, WeTrakr tracking status, Simkl western status.
6. UI (preview text for western status, conflict picks for tv and movie), gallery states.
7. Docs (ARCHITECTURE section 7, TRACKERS), delete this plan.
