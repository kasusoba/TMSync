# Plan: add WeTrakr as the fifth tracker

> **Temporary file. Delete it in the last step (step 7), before the PR merges.** Docs describe
> the current state only. A plan and its log are not permanent docs. The facts that stay true move
> to `docs/TRACKERS.md`, and the history stays in the PR.

Status file for one large PR. All work is on the branch `feat/wetrakr` (draft PR "Adds WeTrakr").
A new session (any device): `git fetch && git checkout feat/wetrakr`, read this file, find the
first unchecked step, and continue. Each step is one or more commits on that branch. Tick the step
and add a log line in the same commit.

- API docs: https://api.wetrakr.com/#/ (a JS app; the reference sits inside its bundle, see
  "Reading the docs" below).
- Goal: WeTrakr gets every feature the other trackers have. Nothing is left out.

## Decisions (settled with the owner, 2026-10-01)

1. **Family `seasoned`**, like Trakt. WeTrakr knows TMDB, IMDb, TVDB, and Letterboxd ids, and no
   AniList or MAL ids. Anime from a cour site reaches it through the crosswalk (derived), the same
   path Trakt uses. Registry order: after Trakt, before Simkl.
2. **Text = a public comment, like Trakt** (`note: "public"`). WeTrakr private notes cap free
   accounts at 100. A public/private choice is a later goal, not part of this plan.
3. **Quick links on wetrakr.com are in scope.** Read the WeTrakr id from the URL, never parse the
   page HTML (WeTrakr terms forbid scraping their site).
4. **Encrypt stored OAuth tokens for every tracker** first, as its own PR. WeTrakr terms ask for
   it, and it hardens the others for free.
5. **No client secret.** PKCE S256 only. WeTrakr terms forbid a secret in an extension.
6. **Attribution:** where TMSync shows a WeTrakr title (badge match, search results, sync
   preview), link its wetrakr.com page. WeTrakr terms require it.
7. The client id is in the local `packages/extension/.env` as `WXT_WETRAKR_CLIENT_ID`. It is not a
   secret (it ships in the bundle), but it is not in git. Add it to the release workflow secrets.

## Steps (commits on `feat/wetrakr`, in order)

- [x] **1. Encrypt tokens.** One non-extractable AES-GCM key (WebCrypto) kept in IndexedDB. A
  `secretItem()` helper in `lib/storage.ts` encrypts on write and decrypts on read. Use it for
  `trakt_tokens`, `anilist_tokens`, `mal_tokens`, `simkl_tokens`. A plain value found on read is
  encrypted in place (no reconnect). A value that fails to decrypt (key lost) reads as
  disconnected. Tests for round trip, migration, and lost key.
- [x] **2. Host access per tracker (refactor).** Today the "ask for host access on Connect" flow
  is MAL-only (`mal/access.ts`, `malConnectIntent`, branches in `popup/App.tsx` and
  `options/App.tsx`, the grant watcher in `mal/service.ts`). Make it data: a `hostOrigins` field
  on `TRACKER_INFO` and one generic request, intent, and grant watcher. MAL keeps working the
  same. WeTrakr needs it (no CORS headers, checked live 2026-10-01).
- [ ] **3. WeTrakr core.** `wetrakr` in `TrackerId` with `V5_TRACKERS` and a schema bump.
  `TRACKER_INFO` (`seasoned`, `rates: "levels"`, `note: "public"`, `fix: "search"`,
  `hostOrigins: ["https://api.wetrakr.com/*"]`). `lib/trackers/wetrakr/`: `config`, `auth`
  (PKCE, single-flight refresh, logout on disconnect), `client` (headers, backoff on 429 and
  5xx), `adapter` (resolve, scrobble), `service` (status, connect, disconnect, search). Mark,
  account row, popup connect, picker toggle, gallery states. Token keys in storage (encrypted).
  On disconnect, clear every WeTrakr cache (terms). Scrobble guardrail: if the episode echoed by
  `start` differs from the one sent, `DELETE /scrobble/playing` and show the numbering warning.
- [ ] **4. Ratings and comments.** `review.ts`: rate show, season, episode (0 to 10). Comment
  on movie, show, season, episode, with the spoiler flag. `watchedState` for the popup.
- [ ] **5. List sync.** `list.ts`, `apply.ts`, list cache. Daily sync too.
- [ ] **6. Quick links on wetrakr.com.** Make quick links family-based (seasoned vs cour) instead
  of Trakt vs AniList (`shared/src/links.ts`, `QuickLinkEditor.tsx`, `options/App.tsx`), share
  one content-script core with `trakt-quicklinks`, add `wetrakr-quicklinks.content.tsx`. Find
  the wetrakr.com URL shapes first (search results give `url: "/movies/483"`).
- [ ] **7. Letterboxd export from WeTrakr, and docs.** Export source picker (Trakt or WeTrakr).
  Move the API facts below into `TRACKERS.md`; update `ARCHITECTURE.md`, `CLAUDE.md`, README,
  store permission text. **Delete this file.** Check that `docs/plans/` is empty before the merge.

## Log

- 2026-10-01: API researched, decisions made, client id received. Key checked live: external id
  lookup and search work, no CORS headers. Foundation audit: the seam is sound (adapter and
  service registries, family-based derivation, provider rows driven by data). Only step 2 and
  the quick-link part of step 6 need refactoring.
- 2026-10-01: Owner chose one PR for the whole feature (not one PR per step). Step 1 done: tokens
  for all trackers are encrypted (`lib/secret.ts`, `secretItem`). Still to check by hand: Firefox
  reload keeps the connection, and the upgrade from a plain-token build.

- 2026-10-01: Step 2 done. `TRACKER_INFO.hostAccess`, `lib/trackers/access.ts`,
  `connectIntent` (names the tracker), `watchConnectGrants` and `connectTracker` in
  `lib/trackers/service.ts`, `trackerTokens` map in storage. MAL works through it unchanged.
  Hand check: connect MAL fresh in Chrome popup, Firefox popup, and Options.

## WeTrakr API facts (checked 2026-10-01)

**Every request:** base `https://api.wetrakr.com`, headers `wetrakr-api-key: <client_id>`,
`wetrakr-api-version: 1`, and `Authorization: Bearer <token>` when signed in. JSON bodies.

**Auth**
- `GET /oauth/authorize?client_id&redirect_uri&code_challenge&code_challenge_method=S256&state`
  (all required). Redirect carries `code` and `state`.
- `POST /oauth/token` `{client_id, code, code_verifier}`. Never send a secret.
- `POST /oauth/token/refresh` `{refresh_token}`. Access token 7 days, refresh token 180 days,
  ROTATES on refresh (old one retired after a short grace window). 401
  `INVALID_REFRESH_TOKEN` = reconnect.
- `POST /oauth/logout` `{refresh_token}` with the bearer token: revoke on disconnect.
- Device flow: `POST /oauth/device/code` `{client_id}`, poll `POST /oauth/device/token`. Fallback
  if WeTrakr allows only one redirect URI (one app per account, so no second app for Firefox).

**Resolve**
- `GET /media/external/{imdb|tmdb|tvdb|letterboxd}/{id}?type=movie|show` gives `{id, type}`. TMDB
  needs `type` (409 with both matches without it).
- `GET /search?q&filter_type=movie|show&limit` (tt ids resolve exactly). `GET /search/all?q`.
- Season and episode: `GET /shows/{id}/seasons/{n}`, `/seasons/{n}/episodes/{e}` (WeTrakr ids
  for comments).

**Scrobble** (body: `movie` or `show` + `episode {season, number}`, each by WeTrakr `id` or
`{title, year, ids}`; `progress` 0 to 100; `app_version`)
- `POST /scrobble/start` (also used for resume and seek; one session at a time). Reply echoes the
  resolved media and episode. 404 `NOT_FOUND` = unknown title.
- `POST /scrobble/pause`. `POST /scrobble/stop`: 80 or more = watched (201 `scrobble`), less =
  paused (200). A stop at 80 or more works without a start. A repeat within one runtime is not
  logged again (same 201), so re-stops are safe.
- `DELETE /scrobble/playing` cancels without logging. `GET /scrobble/playing`.
  `POST /scrobble/checkin`.

**Ratings and comments**
- `POST /sync/ratings` `{movies|shows|seasons|episodes: [{id | ids, rating}]}`, 0 to 10, one
  decimal. Seasons and episodes by number nest under the show like Trakt. `POST
  /sync/ratings/remove`. `GET /sync/ratings/{target}` (with `from_date`, `compact=true`).
- Comment: `POST` (account comments group) with a media object, `text` up to 10,000 chars,
  `spoiler`. Delete: `DELETE /{comment_id}`. Read: `GET /comments/{target}`.
- Private notes (not used yet): `POST /notes`, free cap 100 (420 `PLAN_LIMIT_REACHED`).
  `GET /plan-usage` shows quotas.

**Lists and sync**
- `GET /sync/last_activities` first, then `GET /sync/journal?from_date` for what changed.
- `GET /sync/tracking/{watching|waiting|watched|planning|dropped|paused}/{movies|shows|...}`,
  `compact=true` gives up to 5,000 rows per page with cursor `after`.
- `GET /sync/tracking/watched/history/{movies|episodes}` one row per play.
- `POST /sync/tracking` (status per item, nested seasons and episodes, `tracked_at`,
  `use_release_date`, `tracked_at_unknown`), `POST /sync/tracking/remove`. Up to 5,000 items per
  call, 1 MB body.
- Status map: watching and waiting to CURRENT, planning to PLANNING, watched to COMPLETED,
  dropped to DROPPED, paused to PAUSED. Rating map: ours (0 to 100) = theirs times 10.

**Limits:** per user 200 GET and 60 writes per minute; daily 1,000 (test phase, not enforced).
Headers `RateLimit-*` and `X-Quota-*`. 429 = back off and stop. 423 = app locked. Terms: cache,
check `last_activities` before a re-read, never poll in a loop.

## Reading the docs

The docs page is a React app with no spec file (`/openapi.json` answers 401). The reference is
data inside `/assets/index-<hash>.js`. Download it, then extract every object that holds
`method:"..."` and `path:"/..."` with a small node script that matches braces. Use node
`indexOf` slices to search it: grep with `.{0,N}` context hangs on the one-line bundle.
