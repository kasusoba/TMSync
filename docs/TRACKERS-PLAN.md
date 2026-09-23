# More trackers: MyAnimeList and Simkl

Status (2026-09-23): **Steps 0, 1 (MAL), and 2 (Simkl) built** on `feat/more-trackers`, not
yet pushed. See "Where things stand" at the end. Read alongside `MULTI-TRACK.md` (native vs derived),
`IDENTITY-NAMESPACES.md` (id namespaces, `resolvableNamespaces`), and `CLAUDE.md` →
"Tracker adapters".

Delivery: one branch (`feat/more-trackers`) and one PR for the whole feature, with one
commit (or a few) per step below. Rebase on `main` when other fixes land.

## Decisions (owner, 2026-09-23)

1. **Non-anime may be multi-tracked to seasoned-family trackers.** The old drift guard
   "movies and Western TV are Trakt-only" is relaxed. Movies and TV may go to Trakt and
   Simkl at once. They share numbering (season + episode) and ids (tmdb/imdb/tvdb), so no
   crosswalk is involved. The crosswalk stays anime-only.
2. **MyAnimeList ships first.** It is smaller and fits the existing cour family.
3. **Simkl signs in with the normal OAuth redirect**, not the PIN flow.

## Core idea: numbering families

Today `lib/animap/derive.ts` and `resolveAcross` in `background.ts` bridge exactly one
pair, TMDB numbering (Trakt) to cour numbering (AniList). With four trackers, pairwise
bridging does not scale. Group trackers by how they number episodes:

| family | trackers | episode numbering | ids |
|---|---|---|---|
| **seasoned** | Trakt, Simkl (TV + movies) | season + episode | tmdb, imdb, tvdb |
| **cour** | AniList, MAL | linear, one entry per cour | anilist, mal |

- **Inside a family**, only the id changes. The episode carries over as scraped. Trakt and
  Simkl both resolve tmdb/imdb. AniList and MAL map 1:1 through `Media.idMal`.
- **Across families**, the Fribb crosswalk bridges, and it is written once, family to
  family, not per tracker pair.

Derivation for a target tracker becomes: (1) crosswalk into the target's family, if the
native tracker is in the other family, then (2) map the id inside the family. The
crosswalk stays in `lib/animap/` and never touches `extract()`.

## Step 0: numbering families (refactor, no behavior change)

- Add `family: "seasoned" | "cour"` to `TrackerInfo` in `lib/tracker/types.ts`.
  `seasonless` becomes a helper derived from it.
- Generalize `deriveMedia` / `deriveMediaWith` from `target === "anilist"` branches to
  family-based steps.
- `scripts/build-anime-map.mjs`: add an `m` column (Fribb `mal_id`). Measured
  2026-09-23: only 66 Fribb entries have mal + tmdb but no anilist, and AniList to MAL is
  exactly 1:1, so `a` stays required and mal-only rows are not kept. The map grew from
  303 KB to 383 KB raw (60 KB to 85 KB gzipped).
- `lib/animap/index.ts`: forward hits carry the mal id; reverse starts from an anilist
  or a mal id.
- Adapters gain an optional `resolveById(ids)`, so the background resolves a derived
  tracker by the crosswalk's exact ids without naming AniList.
- Tests: all current derive/animap tests stay green. Add family-level cases.

## Step 1: MyAnimeList adapter

MAL has the same model as AniList: no scrobble API, one list entry per cour, and a
status we own.

**Auth** (`lib/mal/auth.ts`, `lib/mal/config.ts`)
- OAuth2 authorization code with PKCE. MAL supports `code_challenge_method=plain` only.
- Register the app as type "other" so there is no client secret and no backend.
- Access tokens expire (about a month). This is the first tracker that needs
  **refresh-token handling**: refresh on 401 or near expiry, and clear the connection
  when the refresh fails.
- Redirect URI: check if one MAL app accepts both the Chrome and Firefox redirect. If not,
  copy the per-browser credential split in `lib/anilist/config.ts`.

**Identity**
- `resolvableNamespaces: ["mal"]`. AniList keeps `["anilist", "mal"]`. With both on, the
  first match in tracker order is native and the other derives inside the cour family.
- Id resolve: `GET /anime/{id}?fields=num_episodes,media_type,start_date,my_list_status`.
- Title resolve: use AniList's public GraphQL search (no auth) to get `idMal`. It is a
  stronger search than MAL's `GET /anime?q=` (length limits, weak ranking). Fall back to
  MAL search only when AniList has no `idMal`.
- From an AniList-native item: `idMal` directly. From a Trakt-native item: the crosswalk
  `m` column (or `a` then `idMal`).

**Recording** (`PATCH /anime/{id}/my_list_status`, form-encoded)
- No start/pause. One write per episode when `watchedThreshold` is crossed.
- Read before write. `num_watched_episodes = max(remote, ep)`. Never lower it.
- Status map: not on list / `plan_to_watch` / `on_hold` / `dropped` + a watch ⇒
  `watching`. Final episode ⇒ `completed`.
- Completed entry + a rewatch ⇒ ask "Rewatching?" first (same as AniList). On confirm set
  `is_rewatching`. Final episode clears it and increments `num_times_rewatched`.
- Guardrail: `ep > num_episodes` ⇒ refuse and warn (numbering mismatch).
- **Extract the AniList status state machine into a pure shared planner** used by both
  adapters, instead of a second copy.

**Rating and note** (`lib/mal/review.ts`, `REVIEW.mal`)
- Score 1 to 10 (integer) on the cour entry, like AniList's single level.
- Private note in `my_list_status.comments`. No public text.

**UI and wiring**
- `Tracker` union, `TRACKER_INFO.mal`, `TrackedItem` arm (carries `episodes`).
- `MalMark` in `marks.data.ts` + `kit.tsx`, `TRACKER_MARK` entry.
- Account provider row (options) and popup no-account connect button.
- Picker toggle: needs a title, or an anilist/mal id.
- `watchedState`: count-based, like AniList.
- Gallery states for the new row, toggle, and badge outcomes.
- Triage the `=== "anilist"` / `=== "trakt"` branches (about 44 in about 20 files):
  rating-level logic in `scrobble-panels` + badge, fix-panel routing, outcome copy in
  `session.ts`, `backup.ts`.

## Step 2: Simkl adapter

Researched 2026-09-23 against the official docs (api.simkl.org; the whole site is one
file at `https://api.simkl.org/llms-full.txt`, spec at `/openapi.json`). The old Apiary
docs are retired. Design below replaces the earlier guesses.

**Auth (AUTH V2; V1 is retired around April 2027)**
- Register a **V2** app at simkl.com/settings/developer as **"Mobile, desktop & browser
  apps"**: no client secret, redirect URIs required. The type is permanent. Simkl says
  never ship a `client_secret` in an extension (so NOT the Trakt model).
- Authorization code + PKCE, **S256 only** (`plain` is rejected, unlike MAL). Scope must
  be `media:read media:write` (omitting it gives read-only; check `scope` in the token
  response). Authorize: `https://simkl.com/oauth2/authorize`. Token, refresh, revoke:
  `https://api.simkl.com/oauth2/{token,revoke}`, form-urlencoded, `client_id` in the body.
- Callback carries `code`, `state`, `iss`: check `state` AND `iss === "https://simkl.com"`.
- `redirect_uri` is an exact string match, no wildcards. Register both TMSync redirects
  (same two as MAL, see `.env.example`).
- Access token 7 days. Refresh token 180 days, sliding, **non-rotating** (same value
  back). A refresh invalidates the previous access token, so keep one refresher
  (single-flight, like `lib/mal/auth.ts`). Revoke on Disconnect (always returns 200).
- Every request needs query params `client_id`, `app-name` (e.g. `tmsync`),
  `app-version`. `User-Agent` can't be set from browser code; skip it. JSON
  `Content-Type` only on POST.
- **CORS is supported** on api.simkl.com, so Simkl likely needs no host-permission
  prompt (unlike MAL). Verify the token endpoint also answers CORS before relying on it.

**Limits (plan around these)**
- 10 GET/s, 1 POST/s. Daily quota **per user, shared across every app they use**: Free
  500, PRO 1,000, VIP 10,000. Resets at midnight America/New_York.
- **Scrobble lock: one scrobble call per user per 20 s**; a collision returns
  `400 RATE_LIMIT` (not 429). Re-stopping a finished item within 1 h returns `409` (the
  watch is already recorded: treat as ok). The adapter must space its own calls: skip a
  start/pause that falls inside the window, and hold a stop until the window passes so
  the watched write is never lost. Keep the last-call time in storage (constraint #4).

**Identity: do NOT search before writing**
- The docs forbid it: scrobble, history and ratings endpoints match the item server-side
  from `ids` + `title` + `year`. `/search/*` and `/search/id` also need a user token and
  cost quota.
- So the adapter's `resolve()` makes **no network call**: it returns an item built from
  the page (ids, title, year) with no Simkl id yet. The first scrobble response carries
  the matched media object (`ids.simkl`, `ids.slug`, title); cache it per media key and
  show that from then on. `404 id_err` on a write means "not found on Simkl".
- Supported id keys include `tmdb`, `imdb`, `tvdb`, `mal`, `anilist`, `anidb`,
  `traktslug` (no numeric trakt id). `simkl` is an integer, every other id a string.

**Numbering: Simkl takes BOTH families (never the crosswalk)**
- Seasoned: send `show` with tmdb/tvdb ids + `episode: { season, number }`. Simkl maps
  anime to the right AniDB cour itself (AoT S3E13 → "Season 3 Part 2" ep 1). Movies go
  under `movie`.
- Cour: send `anime` with mal/anilist ids + `episode: { number }` (linear).
- Design: a third family value, e.g. `"any"`: Simkl passes the native tracker's media and
  ids straight through (the "same family" path in `derive.ts`), whichever family it is.
  Put Simkl LAST in `ALL_TRACKERS` so it is native only when it is the only enabled
  tracker (it could claim every namespace). When Simkl is native, treat the page's own
  numbering (season present ⇒ seasoned, else cour) as its family for deriving others.

**Recording**: Trakt-like `/scrobble/start|pause|stop` with `progress` (0 to 100). `stop`
≥ 80 ⇒ watched (Simkl owns the decision, like Trakt). One call per user action, never a
timer. Rewatch (`?allow_rewatch=yes` on stop) is PRO/VIP only and needs a 2-day gap:
skip in v1 (a replay of a watched item is dropped by Simkl, which is safe).

**Rating**: `POST /sync/ratings` with `{movies|shows|anime: [{ ids, rating }]}`, 1 to 10,
entry level only (no season/episode). Remove: `/sync/ratings/remove`. **No notes.** The
rate/note composer needs per-tracker flags (e.g. in `TRACKER_INFO`): rating granularity
("levels" for Trakt, "entry" for AniList/MAL/Simkl) and note kind (public / private /
none). Today `levelOk` and the note placeholder infer these from `isSeasonless`, which is
wrong for Simkl.

**Attribution (API rule 1)**: wherever Simkl data shows, link the per-item page
`https://simkl.com/{movies|tv|anime}/{simkl_id}/{slug}` (`trackerItemUrl` needs the slug
and type). Brand mark: `https://us.simkl.in/img_favicon/v2/favicon-192x192.png`.

**UI and wiring**: same checklist as MAL (union, `TRACKER_INFO`, adapter + registry,
`REVIEW.simkl`, mark, Account row, popup button, picker toggle needs a title or any id,
gallery). `watchedState` can return null in v1 (saves quota).

## Cross-cutting

- **Host permissions.** Do not add `api.myanimelist.net`, `myanimelist.net`,
  `api.simkl.com`, or `simkl.com` to the install manifest. New required hosts make Chrome
  disable the extension on update until the user accepts. Put them in
  `optional_host_permissions` and request them on Connect (a user gesture).
- **Rate limits.** Neither API documents generous limits. Writes are rare by design; never
  retry in a tight loop.
- **Backup/restore.** Include the new token and connection keys in `lib/portability`.
- **Docs to update per step:** `CLAUDE.md` (tracker list, adapter table, account rows),
  `MULTI-TRACK.md`, `IDENTITY-NAMESPACES.md` (namespace table), `ARCHITECTURE.md`,
  README, and the store permission justification.

## Later

- Quick links on myanimelist.net and simkl.com pages (new content scripts).
- Crosswalk corrections that cover mal ids in the contribution flow.

## MAL API facts (checked 2026-09-23)

From the official docs (myanimelist.net/apiconfig/references/authorization and
/api/v2). Community notes (ZeroCrystal's guide) are marked as such.

- **Auth:** authorization code + PKCE. Authorize `https://myanimelist.net/v1/oauth2/authorize`,
  token `https://myanimelist.net/v1/oauth2/token` (form-urlencoded). Only
  `code_challenge_method=plain` works, so the challenge equals the verifier (43 to 128
  chars, new per request). App type "Other" gets no client secret: send `client_id` in
  the body and no secret. Verify `state` ourselves. Scope: `write:users`.
- **Redirect URI:** an app can register several. When more than one is registered,
  `redirect_uri` is required and must match exactly, in both the authorize and the token
  request. The docs do not say if `*.chromiumapp.org` / `*.extensions.allizom.org` are
  accepted; the registration form will tell us.
- **Tokens:** docs say the access token lasts one hour and the refresh token one month,
  but their own example has `expires_in` of about 28 days. Trust `expires_in`. A refresh
  (`grant_type=refresh_token`, `client_id`) returns a new refresh token, valid one month
  from then. A user who does not open TMSync for a month must reconnect. An expired
  token gives 401 `invalid_token`.
- **Public reads:** `X-MAL-CLIENT-ID: <client id>` works without login for search and
  details. Writes need the bearer token.
- **Search:** `GET /v2/anime?q=&limit=` (limit max 100). The docs state no `q` length
  limits.
- **Details:** `GET /v2/anime/{id}?fields=...`; fields include `alternative_titles`,
  `start_date`, `media_type`, `num_episodes`, `my_list_status`.
- **Write:** `PATCH /v2/anime/{id}/my_list_status`, form-urlencoded, updates only the
  fields sent: `status` (watching, completed, on_hold, dropped, plan_to_watch),
  `is_rewatching`, `score` (0 to 10), `num_watched_episodes`, `num_times_rewatched`,
  `comments`, and others. `DELETE` on the same path returns 404 when absent.
- **Limits:** no documented rate limit. 403 means "DoS detected". Community reports say a
  temporary IP ban follows bursts, so back off on 403 and never retry in a loop.
- **CORS:** no CORS headers. Fine from the background with a host permission for both
  `myanimelist.net` and `api.myanimelist.net`.

## Where things stand (2026-09-23)

Branch `feat/more-trackers`, local only (not pushed, no PR). One PR for the whole
feature; rebase-merge, never squash (CLAUDE.md "Shipping work").

**Done and live-tested by the owner:** MAL connect, single-tracker MAL, AniList + MAL
multi-track (incl. the "already watched only when no tracker will record" badge rule),
rewatch prompt (shows on page load, tracker icons, confirms every asking tracker).

**MAL gaps closed (2026-09-23):**
- Fix-match picker. One cour-tracker panel (`CourCorrection`) serves AniList and MAL. A
  MAL pin is a tmdb-keyed crosswalk pin (`AnimapOverrides.forwardMal`, wins over the
  AniList pin for MAL only) plus a title-keyed `malCorrections` entry (MAL native). The
  MAL row offers Fix only where it takes effect: a tmdb id, or MAL resolved the page
  itself. A MAL entry derived from AniList follows the AniList match. The options
  ledger lists and clears MAL pins.
- MAL logo: a bundled SVG (`public/mal.svg`, inlined as `MAL_LOGO`), legible at 16 px.
- Docs: `CLAUDE.md`, `MULTI-TRACK.md` (update note), `IDENTITY-NAMESPACES.md`,
  `ARCHITECTURE.md`, README, and the store host-permission text (README listing block).

**Still to confirm live (owner):** MAL rating + private note writes; MAL rewatch fields
(`completed` + `is_rewatching`); the Firefox redirect URI (SHA-1 of the gecko id); the
new MAL fix-match panel (native title pin, and a tmdb pin with Trakt + MAL on).

**Cour fix-match, one shape:** AniList and MAL share `searchCour` / `setCourMatch` /
`resetCourMatch`, keyed by tracker. A set writes both keys (the tmdb pin and the title
pin), so a fix works when the tracker is native on a tmdb page (Trakt off). The MAL title
pin also wins when MAL follows AniList's entry through `idMal`, so the MAL row can always
be fixed. An AniList title pin stores the AniList identity (with `idMal`), so MAL can
follow a pinned entry.

**Before pushing:** fold the `fixup!` commits
(`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash main`), run lint, tsc, tests, build.

**Simkl built (2026-09-23), following the Step 2 design.** Choices made while building:
- `NumberingFamily` gains `any`. `derive.ts` passes the page's numbering and ids through to
  an `any` tracker (plus the native item's ids), and skips crosswalk overrides for it.
  `inferNativeTracker` never picks an `any` tracker while another enabled one exists, so
  Simkl is native only when it stands alone. The record fan-out puts Simkl last.
- `resolve()` makes no network call. The item is the page's title, with Simkl's id and
  title once a scrobble reply names them (`simkl_matches`, keyed per show season, since
  Simkl files each anime season separately). A Simkl id of 0 means "not matched yet".
- The 20 s lock: the last call time is in storage (`simkl_scrobble_at`). A start or
  pause inside it is dropped; a stop waits (at most about 20 s, inside that one request)
  and waits once more on `400 RATE_LIMIT`. `409` on stop counts as recorded. When Simkl
  is derived, a stop that would wait is recorded after the scrobble reply
  (`stopDelayMs` on the seam), so the badge shows the other trackers at once; a
  `scrobbleFollowUp` to the scrobbling frame then updates Simkl's mark. A call that
  never reached Simkl (offline) gives the lock back.
- Rating: `/sync/ratings` (anime under `anime`, remove under `shows`), with a local
  mirror, because reading one rating back costs a whole-list call. The mirror is keyed
  by the rated entry (`simkl:<id>`, else the page item without its season), since
  Simkl rates a western show as a whole. Simkl answers 201
  even when it ignored an item, so `not_found` is checked. Rating an unlisted item makes
  Simkl add it to the user's list (Simkl's documented side effect).
- `TRACKER_INFO` gains `rates` (`levels` / `entry`) and `note` (`public` / `private` /
  `none`). The rating panel uses them instead of `isSeasonless`. With only Simkl
  selected, the panel is "Rate" with no note box.
- No fix-match panel for Simkl: it matches server-side and search is off limits.
- No host permission: api.simkl.com (token endpoint included) answers CORS, checked
  live. The client id was checked live too (the token endpoint accepts it as a public
  V2 client).

**Owner to-dos before a release:** add the `WXT_SIMKL_CLIENT_ID` and `WXT_MAL_CLIENT_ID`
repository secrets (the release workflow now requires both). Register both redirect URIs
on the Simkl app, exactly as the options page shows them.

**Still to confirm live (owner):** Simkl connect (Chrome and Firefox), a scrobble of a
movie, a seasoned show, and an anime page; Trakt + Simkl multi-track; a stop right after a
start (the lock wait, and the badge updating once Simkl records after it); rating and
unrating. On Firefox, confirm the worker stays alive through the wait (`waitAwake` pings
an extension API every 10 s; Chrome counts that as activity, Firefox is unverified). If it
does not, the held stop still goes out from its alarm about 30 s later (`holdStop`).
