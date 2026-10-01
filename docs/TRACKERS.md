# Trackers

What TMSync needs to know about each tracker's API, and how to add a new tracker. How the tracker
layer fits together (the adapter seam, numbering families, native vs derived) is in
[`ARCHITECTURE.md`](./ARCHITECTURE.md#5-tracker-adapters-the-seam-that-keeps-the-trackers-apart).
The rules for recording progress (read before write, never lower progress, the "Rewatching?"
confirm) are in [`CLAUDE.md`](../CLAUDE.md).

Facts about outside services can go stale. Where a fact was checked against a live service or the
official docs, the date is given.

- [Trakt](#trakt)
- [AniList](#anilist)
- [MyAnimeList](#myanimelist)
- [Simkl](#simkl)
- [WeTrakr](#wetrakr)
- [Rating and notes by tracker](#rating-and-notes-by-tracker)
- [List sync: reads and writes](#list-sync-reads-and-writes)
- [Adding a tracker](#adding-a-tracker)

---

## Trakt

- **Auth:** OAuth authorization code through `launchWebAuthFlow`, with refresh-token rotation. The
  client secret is bundled, and there is no backend. There are no per-endpoint scopes: one access
  token authorizes scrobbling, ratings, and comments alike, so adding a write feature needs no
  re-consent.
- **Scrobble:** `POST /scrobble/start|pause|stop` with a progress percentage. Trakt owns the watched
  decision: a stop at 80% or more is added to history, and less than that is kept as paused. History
  is written only on stop.
- **Pause limits:** a pause under 1.0% is rejected ("progress should be at least 1.0% to pause"),
  and so is one that comes too late ("use stop to scrobble"). TMSync skips sub-1% pauses and turns a
  pause at or after `WATCHED_THRESHOLD` (80%) into a stop.
- **Ratings:** `POST /sync/ratings`, 1 to 10. A season or episode is addressed by number, nested
  under the show's Trakt id, so the show id plus scraped numbers is enough.
- **Comments are public.** They show on the profile and the item page. A private per-item note is
  Trakt's Notes feature, which is VIP only. TMSync uses a single public comment as the user's note.
- **Comments need the item's own id.** Unlike ratings, commenting on a season or episode needs that
  item's Trakt id, which costs a lookup (`/shows/{id}/seasons`, then the episode). A comment must
  be at least five words, and TMSync checks that client-side.
- **Ratings made on the website are not read back**, because there is no cheap full-list pull. TMSync
  keeps a local mirror and treats the tracker as the source of truth.

## AniList

- **Auth:** the Authorization Code grant. AniList removed the implicit grant (its authorize
  endpoint answers `unsupported_grant_type` for `response_type=token`, verified 2026-06). The code
  is exchanged at `/oauth/token` with a bundled client secret, so there is still no backend. The
  token lasts about a year and there is no refresh.
- **One redirect URL per app.** Chrome's redirect (`...chromiumapp.org`) and Firefox's
  (`...extensions.allizom.org`) differ, so Firefox builds need a second AniList app. That is why
  `.env.example` has `WXT_ANILIST_CLIENT_ID_FIREFOX` and its secret.
- **API:** one GraphQL POST endpoint. Reads use `Media` (`id`, `idMal`, `title`, `synonyms`,
  `episodes`, `relations`) and the viewer's `MediaList { status progress repeat }`. Writes use
  `SaveMediaListEntry(mediaId, progress, status)`. There is no scrobble endpoint.
- **Scores** follow the user's `mediaListOptions { scoreFormat }`: `POINT_100`, `POINT_10`,
  `POINT_10_DECIMAL`, `POINT_5`, or `POINT_3`.
- **`idMal`** links an AniList entry to MyAnimeList one to one, which is how the two cour trackers
  stay in step without a crosswalk column.
- Rate limits are modest. Writes are rare by design, and nothing retries in a tight loop.

## MyAnimeList

Checked 2026-09-23 against the official docs (`myanimelist.net/apiconfig/references/authorization`
and `/api/v2`).

- **Auth:** authorization code with PKCE. Authorize at `https://myanimelist.net/v1/oauth2/authorize`
  and exchange at `https://myanimelist.net/v1/oauth2/token` (form-urlencoded). **Only
  `code_challenge_method=plain` works**, so the challenge equals the verifier (43 to 128 characters,
  new per request). Register the app as type "other": it gets no client secret, so send `client_id`
  in the body and no secret. Check `state` yourself. The scope is `write:users`.
- **Redirect URIs:** an app can register several. When more than one is registered, `redirect_uri`
  is required and must match exactly in both the authorize and the token request. Register both
  TMSync redirects (see `.env.example`).
- **Tokens:** the docs say one hour for the access token, but their own example has `expires_in` of
  about 28 days, so trust `expires_in`. A refresh (`grant_type=refresh_token`) returns a new refresh
  token, valid for one month. A user who does not open TMSync for a month has to reconnect. An
  expired token gives 401 `invalid_token`. This is why `lib/trackers/mal/auth.ts` refreshes on 401 or near
  expiry, and clears the connection when the refresh fails.
- **Reads:** `X-MAL-CLIENT-ID: <client id>` works without login for search and details.
  `GET /v2/anime?q=&limit=` searches (limit up to 100), and `GET /v2/anime/{id}?fields=...` gives
  `alternative_titles`, `start_date`, `media_type`, `num_episodes`, and `my_list_status`.
- **Writes:** `PATCH /v2/anime/{id}/my_list_status`, form-urlencoded. It updates only the fields
  sent: `status` (`watching`, `completed`, `on_hold`, `dropped`, `plan_to_watch`), `is_rewatching`,
  `score` (0 to 10, 0 clears), `num_watched_episodes`, `num_times_rewatched`, and `comments`.
- **Limits:** no documented rate limit. A 403 means "DoS detected", and community reports say a
  temporary IP ban follows request bursts. Back off on a 403 and never retry in a loop.
- **CORS:** MAL sends no CORS headers. Calls from the background work only with host permission for
  both `myanimelist.net` and `api.myanimelist.net`, so those are optional permissions requested on
  Connect, never in the install manifest. The same grant runs the quick links on myanimelist.net,
  which bridge the MAL id to AniList (`idMal`) for the anime templates.
- **Resolution:** a MAL id directly, an AniList id through AniList's `idMal`, else a title search.
  Searching AniList first to get `idMal` is stronger than MAL's own search (length limits, weak
  ranking), so the MAL title search is the last fallback.

## Simkl

Checked 2026-09-23 against the official docs (`api.simkl.org`; the whole site is one file at
`https://api.simkl.org/llms-full.txt`, and the spec is at `/openapi.json`). The old Apiary docs are
retired.

- **Auth (AUTH V2; V1 retires around April 2027):** register a V2 app at
  `simkl.com/settings/developer` as **"Mobile, desktop & browser apps"**. It gets no client secret
  and needs redirect URIs. The app type is permanent, and Simkl says never to ship a
  `client_secret` in an extension. Use authorization code with PKCE, **S256 only** (`plain` is
  rejected). The scope must be `media:read media:write`, since omitting it gives read-only access,
  so check `scope` in the token response. Authorize at `https://simkl.com/oauth2/authorize`. Token,
  refresh, and revoke are at `https://api.simkl.com/oauth2/{token,revoke}`, form-urlencoded, with
  `client_id` in the body.
- **Callback:** it carries `code`, `state`, and `iss`. Check `state` and `iss ===
  "https://simkl.com"`. `redirect_uri` is an exact string match with no wildcards, so register both
  TMSync redirects.
- **Tokens:** the access token lasts 7 days. The refresh token lasts 180 days, slides, and is
  non-rotating (the same value comes back). A refresh invalidates the previous access token, so keep
  a single refresher (single-flight, like `lib/trackers/mal/auth.ts`). Revoke on Disconnect (it always
  returns 200).
- **Every request** needs the query params `client_id`, `app-name`, and `app-version`. Browser code
  cannot set `User-Agent`, so skip it. Send a JSON `Content-Type` only on POST.
- **CORS:** `api.simkl.com`, the token endpoint included, answers CORS (checked live), so the API
  needs no host permission. Connect asks for `simkl.com` only, for its quick links, which read the
  ids from the page's external links and so cost no quota.
- **Limits:** 10 GET per second and 1 POST per second. The daily quota is **per user and shared
  across every app they use**: 500 on Free, 1,000 on PRO, 10,000 on VIP, resetting at midnight
  America/New_York.
- **Scrobble lock:** one scrobble call per user per 20 seconds. A collision returns
  `400 RATE_LIMIT`, not 429. Stopping a finished item again within an hour returns `409`, which
  means the watch is already recorded and counts as ok. The adapter spaces its own calls: it drops a
  start or pause inside the window and holds a stop until the window passes, so the watched write is
  never lost. The last call time lives in storage (`simkl_scrobble_at`), because the background is
  stateless. A held stop also has an alarm as a backstop, in case the worker sleeps through the wait.
- **No search before a write.** The docs forbid it. Scrobble, history, and ratings endpoints match
  the item server-side from `ids`, `title`, and `year`, and `/search/*` needs a user token and costs
  quota. So `resolve()` makes no network call. It builds an item from the page, and the first
  scrobble reply carries the matched media (`ids.simkl`, `ids.slug`, title), which is cached per show
  season (`simkl_matches`) because Simkl files each anime season separately. A Simkl id of 0 means
  "not matched yet", and `404 id_err` on a write means "not found on Simkl". Supported id keys
  include `tmdb`, `imdb`, `tvdb`, `mal`, `anilist`, `anidb`, and `traktslug`. `simkl` is an integer
  and every other id is a string.
- **Fix match** is the one search. `GET /search/{movie|tv|anime}?q=` (user token) runs only on the
  user's click in the fix-match panel or manual mode. A movie searches `movie` and `anime` (anime
  films), a show `tv` and `anime`. Results carry `ids.simkl_id` and sometimes `ids.tmdb` (a
  string), never imdb. The pick is pinned in `simkl_matches` (`pinned: true`): later writes send
  only `{ simkl: id }`, so a wrong page id cannot pull the match away, and a scrobble reply never
  overwrites the pin.
- **Numbering takes both families.** For a seasoned page, send `show` with tmdb or tvdb ids and
  `episode: { season, number }`, and Simkl maps anime to the right AniDB cour itself. Movies go under
  `movie`. For a cour page, send `anime` with mal or anilist ids and `episode: { number }`. This is
  why Simkl is the `any` family and never uses the crosswalk.
- **Recording** is Trakt-like: `/scrobble/start|pause|stop` with `progress` from 0 to 100, and a stop
  at 80 or more is watched (Simkl owns the decision). Rewatch (`?allow_rewatch=yes` on stop) is PRO
  and VIP only and needs a 2 day gap, so v1 skips it. A replay of a watched item is dropped by
  Simkl, which is safe.
- **Ratings:** `POST /sync/ratings` with `{movies|shows|anime: [{ ids, rating }]}`, 1 to 10, at the
  entry level only. Remove with `/sync/ratings/remove`. Simkl answers 201 even when it ignored an
  item, so check `not_found`. Reading one rating back costs a whole-list call, so TMSync keeps a local
  mirror keyed by the rated entry. Rating an unlisted item makes Simkl add it to the user's list
  (documented). Simkl has no notes.
- **Attribution (API rule 1):** wherever Simkl data shows, link the per-item page
  `https://simkl.com/{movies|tv|anime}/{simkl_id}/{slug}`.
- **Firefox:** the worker's wait for the lock relies on `waitAwake` pinging an extension API every
  10 seconds. Chrome counts that as activity, and Firefox is unverified. If Firefox sleeps the
  worker, the held stop still goes out from its alarm about 30 seconds later.

## WeTrakr

Checked 2026-10-01 against the official docs (`https://api.wetrakr.com/#/`). The docs page is a
JavaScript app with no spec file: the reference is data inside its `/assets/index-<hash>.js` bundle.
The API is in beta, so check it again before relying on a detail.

- **App:** registered on request (WeTrakr Discord), one app per account, so no second app for
  Firefox: ask for both TMSync redirect URIs on the one app. The client id is the public app key.
- **Every request** carries `wetrakr-api-key: <client id>` and `wetrakr-api-version: 1`, plus
  `Authorization: Bearer` when signed in. JSON bodies.
- **Auth:** `GET /oauth/authorize` with `client_id`, `redirect_uri`, `code_challenge`,
  `code_challenge_method=S256`, and `state` (all required). Exchange at `POST /oauth/token` with
  `{client_id, code, code_verifier}`. **Never send a secret:** the terms forbid one in an app users
  install, and a wrong one burns the code. The access token lasts 7 days and the refresh token 180.
  `POST /oauth/token/refresh` ROTATES the refresh token (the old one has a short grace window), so
  refresh single-flight. A 401 `INVALID_REFRESH_TOKEN` means connect again. Disconnect calls
  `POST /oauth/logout` with the refresh token. A device flow exists too (`/oauth/device/*`).
- **CORS:** none, the preflight included. `api.wetrakr.com` is an optional host permission asked
  on Connect, with `wetrakr.com` for its quick links (`TRACKER_INFO.hostAccess`).
- **Resolve:** `GET /media/external/{tmdb|imdb|tvdb}/{id}?type=movie|show` gives `{id, type}`; TMDB
  needs `type` (409 with both matches without it). Then `GET /movies/{id}` or `/shows/{id}` for the
  title and ids. Else `GET /search?q&filter_type=movie|show`. Search results carry NO external ids,
  so a manual pick reads each hit's detail (cached in `wetrakr_ids_cache`). WeTrakr ids are not TMDB
  ids: the two id spaces overlap. Seasons and episodes: `/shows/{id}/seasons/{n}` and
  `/seasons/{n}/episodes/{e}`.
- **Scrobble:** `POST /scrobble/start|pause|stop` with `movie` or `show` + `episode {season,
  number}` (by WeTrakr `id`, or `{title, year, ids}`), `progress` 0 to 100, and `app_version`.
  WeTrakr owns the watched decision: a stop at 80 or more logs the play (201 `scrobble`), less is a
  pause. A stop at 80 or more works without a start. A repeat inside one runtime is not logged
  again, so a second stop is safe. `start` echoes the episode it matched: TMSync compares it with the
  one sent, and on a mismatch it calls `DELETE /scrobble/playing` (cancel, no play logged) and shows
  the numbering warning. A 404 means the title or episode is not on WeTrakr.
- **Ratings:** `POST /sync/ratings` and `/sync/ratings/remove`, 0 to 10 with one decimal, at the
  movie, show, season, or episode level. Seasons and episodes nest by number under the show, like
  Trakt. TMSync sends whole stars. The user's rating of one item is
  `interactions.user.rating.rating` on the item with `?extended=interactions`.
- **Comments are public** (the note, like Trakt): `POST /sync/comments` with one of `movie`,
  `show`, `season`, `episode` (a season or episode by its own id), `text` (up to 10,000
  characters, no minimum), and `spoiler`. `DELETE /sync/comments/{id}`. There is **no edit**: a
  changed note posts a new comment, then deletes the old one. Private notes exist (`/sync/notes`)
  but a free account keeps only 100, so TMSync does not use them.
- **Watched progress** (the popup): the per-season episode lists carry the user's tracking state
  when signed in. One call per season, so it is kept 5 minutes and skipped above 15 seasons.
- **Limits:** per user, 200 GET and 60 writes a minute; a daily quota (1,000 on a free account) is
  in test and not enforced. Headers `RateLimit-*` and `X-Quota-*`. 429 = back off, 420 = plan
  limit, 423 = the app is locked.
- **Terms:** link the item's wetrakr.com page wherever its data shows; cache, and check
  `/sync/last_activities` before a list is read again; never poll in a loop; never parse
  wetrakr.com HTML (the quick links read the URL and the API); delete the user's WeTrakr data on
  disconnect; store tokens encrypted.

## Rating and notes by tracker

The rating panel reads `TRACKER_INFO.rates` and `.note`, never the tracker name or its numbering
family.

| | **Trakt** | **WeTrakr** | **AniList** | **MyAnimeList** | **Simkl** |
|---|---|---|---|---|---|
| Rate at | show, season, or episode | show, season, or episode | the cour entry | the cour entry | the movie or show |
| Score scale | 1 to 10 | 0 to 10 (TMSync sends 1 to 10) | the user's `scoreFormat` | 1 to 10 integer (0 clears) | 1 to 10 integer |
| Text | a public comment (5 words or more) | a public comment (no minimum, no edit) | a private note (`MediaList.notes`) | a private note (`comments`) | none |
| Public review | deferred | comments of 200 words or more show as reviews | deferred (`SaveReview`, a separate public entity with a long minimum) | none | none |

Score and note both write to the cour entry on AniList and MAL. There is no episode-level score and
no object above the entries to rate. Rating prompts fire on completion only.

## List sync: reads and writes

How list sync reads and writes each tracker. How it plans is in
[`ARCHITECTURE.md`](./ARCHITECTURE.md), section 7. Read before live use, 2026-09-28.

| | **Reads (one preview)** | **Writes (apply)** | **Spacing and stops** |
|---|---|---|---|
| Trakt | `/sync/last_activities`, then (if it moved) up to 8 paged GETs: `/sync/watched/shows?extended=progress`, `/sync/watched/movies`, `/sync/ratings/{shows,seasons,movies}`, `/sync/watchlist/{shows,movies}`, `/users/hidden/dropped?type=show` | `POST /sync/history`, `/sync/ratings`, `/sync/ratings/remove`, `/sync/watchlist`, `/sync/watchlist/remove`, `/users/hidden/dropped`, `/users/hidden/dropped/remove`, up to 100 items each | 1.1 s between POSTs. 429 or 420 stops Trakt. |
| WeTrakr | `/sync/last_activities`, then (if it moved): the show lists `/sync/tracking/{watching,waiting,watched,paused,dropped,planning}/shows` (titles, status), the compact episode plays `/sync/tracking/watched/history/episodes`, `/sync/tracking/{watched,planning,dropped}/movies`, and `/sync/ratings/{shows,seasons,movies}` (paged) | `POST /sync/tracking` (status `watched` per episode or movie), a second `POST /sync/tracking` for statuses, `POST /sync/ratings`, `POST /sync/ratings/remove`, up to 100 items each | 1.1 s between POSTs (60 writes a minute). 429, 420, or 423 stops WeTrakr. |
| AniList | `Viewer`, then `MediaListCollection` in chunks of 500 (custom lists too, one entry per media: an entry hidden from status lists is only there) | a fresh `Page.mediaList(mediaId_in)` read per 25 entries, then one `SaveMediaListEntry` or `DeleteMediaListEntry` per entry | 2.1 s between requests. A 429 waits out `Retry-After` once; a second one stops AniList. |
| MyAnimeList | `/users/@me/animelist`, 1000 per page, one page at a time | per entry: `GET /anime/{id}` (`my_list_status`), then `PATCH` or `DELETE /anime/{id}/my_list_status` | 1.5 s between requests. A 403 stops MAL. |
| Simkl | `/sync/activities`, then 0 to 3: `/sync/all-items/{shows,anime,movies}` for the types that moved, with `date_from` when nothing was removed | `POST /sync/history/remove`, `/sync/history`, `/sync/add-to-list`, `/sync/ratings`, `/sync/ratings/remove`, up to 250 items per chunk | 1.1 s between POSTs. A 429 stops Simkl. |

- **Trakt.** Watches and ratings are separate lists, so an item that is rated but not watched is
  still read as an entry. A history write always adds a play, so the plan diffs against what
  Trakt has and never sends one twice. `watched_at` is the source list's date, else `"released"`
  (the air date). A season rating nests in its show: `shows: [{ ids, seasons: [{ number, rating }] }]`.
  Trakt echoes items it could not match in `not_found`. Trakt has no list entries, so sync never
  removes from it. Its statuses are two lists: the watchlist (`/sync/watchlist`, plan to watch,
  movies and shows) and dropped shows (`/users/hidden/dropped`, shows only), each with a
  `/remove`. Since July 2026 `/sync/watched/shows` leaves out the seasons unless the request asks
  for `extended=progress`, and every watched list must be paged (`page`, `limit`). Trakt may apply
  a smaller limit than asked, so the reader follows `X-Pagination-Page-Count` and stops on an
  empty page.
- **WeTrakr.** Sync treats it like Trakt (the `seasoned` family): watches, ratings (season
  ratings too), and statuses; it removes nothing, and cannot be a main list, because its plays are
  watch history. A watch write gives each episode its own `watched` status, so the show's status
  is untouched, and `tracked_at` (else `use_release_date`) dates it. A status write is a second
  `/sync/tracking` POST after the watches, with the show's or movie's list and no seasons:
  `planning`, `watching`, `paused`, `dropped` (movies: `planning`, `dropped`). Never a bare
  `watched` (it would log every aired episode), and `none` clears a list without deleting plays.
  The reader takes each show's status from the tracking list it is in, where `waiting` (caught up,
  still airing) reads as watching; a caught-up show can also be in `watched`, and the other list
  wins. WeTrakr echoes what it could not resolve in `notFound` and what it refused in `errored`
  (camel case). Compact rows carry no titles, which is why the show lists are read too.
- **AniList.** Read scores with `score(format: POINT_100)`, so every score is 0 to 100, and write
  with `scoreRaw` (0 clears a rating). A removal needs the LIST ENTRY id (`MediaList.id`), not the media id; the fresh
  read before each write gives it. `private` entries, entries hidden from status lists (`hiddenFromStatusLists`), and `isAdult` media are skipped by default.
- **MyAnimeList.** Read with `nsfw=true`, or adult entries are missing from the list. Rewatching is
  `completed` plus `is_rewatching`, and `num_episodes: 0` means unknown. A score of 0 clears a
  rating. `DELETE` answers 404 when
  the anime is not on the list, which counts as done.
- **Simkl.** Anime goes under `shows[]` on every sync endpoint: `/sync/history/remove` ignores an
  `anime[]` array. An anime is named by its cour ids (`mal`, `anilist`) and its Simkl id only; a
  TMDB show id names every cour of the show. A cour count is sent as top-level `episodes` (AniDB
  numbering). An item on `/sync/history` can carry `status` and `rating` too, so an anime status
  needs no `/sync/add-to-list` call, and a bare `status: "completed"` marks a whole item watched.
  The status of a non-anime movie or show goes to `/sync/add-to-list`, each item with its own `to`
  (movies skip `watching` and `hold`). TV episodes are in TVDB order, so episodes from Trakt or
  WeTrakr (TMDB order) can miss. A bare
  item on `/sync/history/remove` removes it from the library entirely. Simkl answers 201 even when
  it matched nothing, so `not_found` (a verbatim copy of what was sent) is the only signal. There is
  no rewatch count. `watched_at` is omitted when the date is unknown (Simkl has no "released"). A
  read refreshes the local rating mirror for the items it returns. Any sync on a timer must call
  `/sync/activities` first and read only what changed, with `date_from` sent exactly as activities
  returned it (Simkl suspends a `client_id` that polls without it). A delta never lists removed
  items; `removed_from_list` only says that something was removed. A delta can come back with an
  empty body. Source (2026-09-28): api.simkl.org/guides/sync; the Apiary docs are frozen.

## Adding a tracker

A tracker goes behind the adapter seam. It never gets special-cased in the shared engine or
`extract()`, and it must not touch the other trackers' paths. Open an issue before you build one.
Work through this list, and grep for `=== "anilist"` and `=== "trakt"` to find branches that assume
a fixed set:

1. **Types.** Add the id to the `Tracker` union and `TrackerId` in `packages/shared`, and give it a
   `TRACKER_INFO` entry in `lib/trackers/types.ts`: `label`, `family` (`seasoned`, `cour`, or `any`),
   `rates`, `note` (and `noteMinWords`), how a wrong match is fixed, `hostAccess` when the API has
   no CORS, and `exportsLetterboxd` when the service can export movies. Bump `SCHEMA_VERSION` (see
   [`RECIPES.md`](./RECIPES.md#versioning)), since an older build cannot parse the new value.
2. **Adapter.** Add `lib/trackers/<tracker>/` with a `TrackerAdapter`: `resolve`, `recordProgress`,
   `ratingLevels`, `watchedState`, and `resolvableNamespaces`, strongest id first. Register it in
   `ADAPTERS` (`lib/trackers/index.ts`). A tracker in the cour family reuses the pure planner in
   `lib/trackers/cour-plan.ts`. Put it last in `ALL_TRACKERS` if it could claim every namespace.
3. **Auth and config.** Add `auth.ts` and `config.ts`, and a client ID in `.env.example`, the release workflow's secret check, and `wxt.config.ts` if needed.
4. **Host access.** Never add a host to the install manifest. A required host makes Chrome disable
   the extension on update until the user accepts. List the origins in `TRACKER_INFO.hostAccess`
   (with the `site` name the user sees). The popup and options ask for them on Connect
   (`lib/trackers/access.ts`), the background checks them before `connect()`, and a first grant
   from a popup that the prompt closed finishes in `watchConnectGrants`. The tracker's client calls
   `hasTrackerAccess` before each request. Skip this if the API answers CORS.
5. **Service.** Add `review.ts` and a `service.ts` with a `TrackerService`: account status, connect,
   disconnect, the rating and note calls, any alarms or wake listeners, and message handlers for
   features only this tracker has. A cour tracker also
   brings its fix-match `pins` (the type requires them). If the tracker can search, add `search`
   (and `pinPick` if a pick's ids alone could drift), so manual mode can use it. Register it in
   `SERVICES` (`lib/trackers/service.ts`). The background needs no edit.
6. **UI.** Add a mark (`marks.data.ts`, `kit.tsx`, the `TRACKER_MARK` entry) and a picker toggle
   entry in `PickerPanel.tsx`. The Options account rows and the popup connect buttons loop over
   `ALL_TRACKERS`, so they need no edit; the gallery's `OptionsView` mock is hand-wired, so add a
   row there, and add the new states to the gallery. A tracker with quick links on its own site
   adds a runtime quick-links script and joins `QUICK_LINK_PAGES`; keep its host out of the
   install manifest (`wxt.config.ts` strips it).
7. **Storage and backup.** Define the token item with `secretItem` in `lib/storage.ts` (stored
   encrypted) and add it to `trackerTokens`. Tokens never go in a backup; add the tracker to the
   backup's list sync `kinds` schema (`lib/portability/backup.ts`).
8. **List sync (optional).** Add `list.ts` (a pure normalizer to `ListEntry`) and `apply.ts`
   (writes to API calls, `unrate` included), and wire `readList` and `applyList` in the service.
   Without them the tracker takes no part in list sync. If the API has a cheap change check, use
   the saved list `readList` gets (`lib/sync/list-cache.ts`), and return the list to save. Add the
   tracker to `LIST_SYNC_CACHE` in `lib/storage.ts`.
9. **Docs.** Update the tracker table in `ARCHITECTURE.md`, `CLAUDE.md`, and the README, the facts
   for the new API in this file, and the store permission justification.
10. **Tests.** Add family-level derive cases, and keep the existing derive and animap tests green.
