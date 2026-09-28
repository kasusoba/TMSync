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
- [Rating and notes by tracker](#rating-and-notes-by-tracker)
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
  Connect, never in the install manifest.
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
- **CORS:** `api.simkl.com`, the token endpoint included, answers CORS (checked live), so Simkl needs
  no host permission.
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

## Rating and notes by tracker

The rating panel reads `TRACKER_INFO.rates` and `.note`, never the tracker name or its numbering
family.

| | **Trakt** | **AniList** | **MyAnimeList** | **Simkl** |
|---|---|---|---|---|
| Rate at | show, season, or episode | the cour entry | the cour entry | the movie or show |
| Score scale | 1 to 10 | the user's `scoreFormat` | 1 to 10 integer (0 clears) | 1 to 10 integer |
| Text | a public comment (5 words or more) | a private note (`MediaList.notes`) | a private note (`comments`) | none |
| Public review | deferred | deferred (`SaveReview`, a separate public entity with a long minimum) | none | none |

Score and note both write to the cour entry on AniList and MAL. There is no episode-level score and
no object above the entries to rate. Rating prompts fire on completion only.

## Adding a tracker

A tracker goes behind the adapter seam. It never gets special-cased in the shared engine or
`extract()`, and it must not touch the other trackers' paths. Open an issue before you build one.
Work through this list, and grep for `=== "anilist"` and `=== "trakt"` to find branches that assume
a fixed set:

1. **Types.** Add the id to the `Tracker` union and `TrackerId` in `packages/shared`, and give it a
   `TRACKER_INFO` entry in `lib/trackers/types.ts`: `label`, `family` (`seasoned`, `cour`, or `any`),
   `rates`, `note`, and how a wrong match is fixed. Bump `SCHEMA_VERSION` (see
   [`RECIPES.md`](./RECIPES.md#versioning)), since an older build cannot parse the new value.
2. **Adapter.** Add `lib/trackers/<tracker>/` with a `TrackerAdapter`: `resolve`, `recordProgress`,
   `ratingLevels`, `watchedState`, and `resolvableNamespaces`, strongest id first. Register it in
   `ADAPTERS` (`lib/trackers/index.ts`). A tracker in the cour family reuses the pure planner in
   `lib/trackers/cour-plan.ts`. Put it last in `ALL_TRACKERS` if it could claim every namespace.
3. **Auth and config.** Add `auth.ts` and `config.ts`, and a client ID in `.env.example`, the release workflow's secret check, and `wxt.config.ts` if needed.
4. **Host access.** Never add a host to the install manifest. A required host makes Chrome disable
   the extension on update until the user accepts. Put it in `optional_host_permissions` and request
   it on Connect. Skip this if the API answers CORS.
5. **Service.** Add `review.ts` and a `service.ts` with a `TrackerService`: account status, connect,
   disconnect, the rating and note calls, and any alarms or wake listeners. A cour tracker also
   brings its fix-match `pins` (the type requires them). Register it in `SERVICES`
   (`lib/trackers/service.ts`). The background needs no edit.
6. **UI.** Add a mark (`marks.data.ts`, `kit.tsx`, the `TRACKER_MARK` entry), an Account row in
   Options, a connect button in the popup, and a picker toggle entry in `PickerPanel.tsx`. Provider
   rows are hand-wired per provider, not a loop. Add the new states to the gallery.
7. **Storage and backup.** Add token and connection keys in `lib/storage.ts` and to
   `lib/portability`.
8. **Docs.** Update the tracker table in `ARCHITECTURE.md`, `CLAUDE.md`, and the README, the facts
   for the new API in this file, and the store permission justification.
9. **Tests.** Add family-level derive cases, and keep the existing derive and animap tests green.
