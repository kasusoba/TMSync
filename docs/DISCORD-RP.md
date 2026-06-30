# Discord Rich Presence — decision note

**Status: PARKED on branch `discord-rich-presence` (2026-06-30). The feature is BUILT and fully working — the owner is going the PreMiD route instead, so it lives on a branch, NOT on `main`.** Don't rebuild from scratch: everything below is the record, and the branch has the working code + tests. PreMiD is a parallel system (its plugins re-scrape the page in PreMiD's own store — it reuses none of TMSync's engine), so this code isn't reusable there; it's preserved for when/if TMSync wants its own RP again.

**The single most important learning (so it's never re-derived):** the Discord member-list line shows the **title** (not the app name) via the activity field **`status_display_type: 2`** (Details) — works on both the relay/RPC path and the Vencord `LOCAL_ACTIVITY_UPDATE` path. We wasted three rounds guessing (app-name-forced → Spotify sync fields → Social SDK) before finding it in the docs. Check official platform docs first.

**Previously (pre-park):** SHIPPED as experimental, off-by-default (built 2026-06-30, reversing the 2026-06-29 deferral). Built along the "chosen-if-ever" path: a neutral `PresenceSink` seam with two transports — a custom **Vencord plugin** (push, cross-platform, `~/projects/dev/Vencord`) as default, and lolamtisch's **relay** (pull, no Apple-Silicon helper) as the alternative. The research below is kept intact.

## TL;DR
Showing "Watching X · S2E5" on the user's Discord profile is a **transport problem, not a data problem** — TMSync already produces the entire Rich Presence payload as a side effect of scrobbling. The blocker is that **a browser extension physically cannot set Discord presence without a native helper process**, and the only helper an extension can actually reach today is a lightly-maintained third party that is **broken on Apple Silicon**. For a social-flex feature tangential to TMSync's passive-scrobbler core, that foundation is too weak to ship. Parked.

## Why it's a data non-problem
The content-script session already knows, in real time, everything Discord RP wants:

| RP field | TMSync already has |
|---|---|
| `details` (line 1) | resolved title |
| `state` (line 2) | "S2E5" / "Episode 7 / 12" (+ the new `watchedState`) |
| `timestamps.start/end` | `video.currentTime` + `duration` → live elapsed/remaining bar |
| `assets.large_image` | poster (AniList `coverImage` / Trakt-TMDB) |
| activity type / small image | play/pause state already drives the badge |

So TMSync's own work is ~80 lines + a settings toggle + registering a TMSync Discord application (for `clientId` + art).

## The hard wall (verified)
Discord presence is set over Discord's **local IPC socket** (`discord-ipc-N`, a unix socket / named pipe). A sandboxed client — i.e. a **browser extension or web page** — cannot open it. There is also **no server-side API** to set a *user's* presence remotely (Discord blocks that by design; bots can only set their own).

⟹ **True RP mandates a locally-running native helper. No exceptions.** The only thing that varies is *who supplies the helper* and *whether an extension can reach it*.

Corollary the owner reasoned out: the only client class that needs a relay at all is **browser extensions** — every native/Electron/CLI/game client just opens the IPC socket directly with a library. That's why the "needs a relay" ecosystem is so thin.

## Options surveyed
| Option | Verdict |
|---|---|
| **A — Piggyback lolamtisch's relay** ("Discord Rich Presence" ext, same dev as MALSync) | The one inbound API reachable *from an extension* (via `chrome.runtime.sendMessage` extension-to-extension, not a socket). Cheapest. **Chosen-if-ever**, but see the Mac blocker. |
| **B — Build our own native-messaging host** | Technically clean & independent (`connectNative` bypasses the Origin/socket problem). **Dead on adoption** — nobody installs a native app for one niche extension's flex feature. The whole point of a helper is being *shared* across sources. |
| **PreMiD** | Different model — you can't feed it; presence is done by PreMiD plugins that **re-scrape** inside PreMiD's own store. No reuse of TMSync's engine. Out. |
| **CustomRP** | **Manual** static presence editor (user types fields), **Windows-only**, no inbound API. Dead end for automation. |
| **Vencord CustomRPC plugin** | Also **manual-only**. (Vencord's role in a live setup is only as a *receiver* via the separate WebRichPresence/arRPC plugin.) |
| **arRPC** | Open-source RPC-server reimplementation, scriptable — **but unreachable from a browser extension**: its inbound WebSocket (ports 6463–6472) enforces an Origin allowlist (empty / `discord.com` only), and a browser stamps an un-overridable `chrome-extension://…` Origin → rejected. Its bridge (:1337) is outbound-only. Would itself need a native helper to bridge. |

**Inbound vs outbound, for the record:** "has an inbound API" = runs a listener others connect *to* (like a phone line that accepts calls). Discord/arRPC have inbound *sockets* but won't accept an extension's call. lolamtisch's relay accepts the call because its inbound door speaks **extension messaging**, not sockets — then it forwards to *its own* helper, which does the IPC.

## The chosen-if-ever path: A (lolamtisch relay)
- **Relay:** [github.com/lolamtisch/Discord-RPC-Extension](https://github.com/lolamtisch/Discord-RPC-Extension) (GPL-3.0). Open, reusable API — explicitly designed for multiple data-extensions (MALSync, PreWrap, … potentially TMSync) to share one relay + helper. Not MALSync-specific (no `externally_connectable` allowlist).
- **Protocol (small):**
  - Content script registers once: `chrome.runtime.sendMessage(relayId, { mode: 'active' })` (`active` = only when tab focused; `passive` = always shown).
  - The relay **polls every 15 s**; your `onMessage` listener must **return a presence on every poll or it gets unregistered** (return `{}` to stay registered but show nothing — e.g. when paused).
  - Background needs ~5 lines of `onMessageExternal` glue forwarding pulls to the active tab.
  - Payload = Discord RP shape passed straight through: `{ clientId, presence: { details, state, startTimestamp/endTimestamp, smallImageKey, buttons, type:3 } }`.
- **Chain:** TMSync ext → relay ext (extension messaging) → relay's Node helper (`ws://localhost:6969`) → Discord IPC (`@xhayper/discord-rpc`) → Discord desktop.

## The Apple Silicon blocker (why it's deferred)
The relay's helper is a **pure Node app** packaged with the deprecated Vercel `pkg`. The shipped `macos.zip` is **x64-only**; on Apple Silicon it fails with `Bad CPU type in executable` and Rosetta does **not** rescue a `pkg` binary (open issue [#76](https://github.com/lolamtisch/Discord-RPC-Extension/issues/76), maintainer: can't easily build arm with their current toolchain). Last release 2024-09-08; lightly maintained.

- **Power user / dev escape hatch:** it's pure Node with no arch-locked modules (no-tray path), so `git clone … && npm install && node server.js` runs natively on arm64. Fine for the owner; a non-starter for normal Mac users.
- **Upstream fix exists but isn't ours to own:** swap `pkg` → the maintained `@yao-pkg/pkg` fork (supports `macos-arm64`) via a small PR. Not worth taking on for a nice-to-have.

## Recommendation (original, 2026-06-29)
**Don't build it.** It's a social-flex add-on tangential to the passive-scrobbler core, and its entire viability is hostage to a third-party helper that's broken on the owner's own platform.

If ever revisited: ship **A** as an explicitly **experimental, off-by-default** toggle (docs: "needs lolamtisch's relay + helper; Apple Silicon → run helper from source"), and route it through an internal **`PresenceSink` seam** so TMSync is coupled to its *own* neutral session-presence event, not to lolamtisch's extension directly — making any future bridge a ~30-line adapter swap rather than a rewrite. Do **not** build B (own native host) or a PreMiD plugin.

## Implementation (what shipped, 2026-06-30)
Built precisely to that recommendation. The seam decouples TMSync from lolamtisch's extension; swapping transports (e.g. a future native host) is a new `PresenceSink`, nothing else changes.

- **Seam:** `packages/extension/lib/presence/`
  - `types.ts` — `PresenceState`, TMSync's own neutral session-presence event (title / subtitle / paused / start+end epochs / tracker / siteName). Nothing here knows about Discord.
  - `sink.ts` — `PresenceSink { register(); poll(state) }`. The poll model matches the relay: it requests presence every ~15 s and we must answer every time (`{}` = stay registered, show nothing).
  - `discord-relay.ts` — the only sink today. `register()` knocks on the relay via `browser.runtime.sendMessage(RELAY_ID, { mode: 'active' })`; `poll()` is a **pure** map from `PresenceState` → Discord activity (`type:3`, `details`/`state`, `startTimestamp`/`endTimestamp`, `largeImageKey:'tmsync'`, `smallImageKey:'play'|'pause'`). Unit-tested (`discord-relay.test.ts`).
  - `config.ts` — bundled `WXT_DISCORD_CLIENT_ID` (like the Trakt/AniList ids, **no backend** — constraint #7) + the relay's per-browser extension id.
  - `snapshot.ts` — per-tab presence in `session:` storage; `focusedPresence()` returns the focused tab's snapshot (relay `active` mode = focused tab only) and drops stale "playing" snapshots from dead tabs.
- **Producer:** `lib/scrobble/session.ts` emits `reportPresence` on play / pause / the 5 s progress tick / clear, gated by the toggle (read + `.watch()`-ed live). The shared engine and `extract()` are untouched.
- **Transport glue (background):** `entrypoints/background.ts` registers on cold start (if enabled), answers the relay's polls via a raw `runtime.onMessageExternal` listener (only `sender.id === RELAY_ID`), and re-registers on the first `reportPresence` of a session (survives a relay reload). Stays stateless (constraint #4) — every poll reads `session:` storage.
- **Manifest:** Chrome gets `externally_connectable: { ids: ['agnaejlkbiiggajjmnpmeheigkflbnoo'] }` so only the relay can message us (web pages can't); Firefox needs none (it doesn't gate extension-to-extension messaging). **No host permission** — it's pure extension messaging.
- **UI:** Options → Display → "Experimental" → an **off-by-default** Switch + a **transport** selector (Vencord plugin / Relay + helper). If no `WXT_DISCORD_CLIENT_ID` is bundled, the toggle explains it stays inert.

## Transports (two ways the activity reaches Discord — pick ONE)
The seam means each transport is just another way to ship the same `PresenceState`. The owner picks one in options (running both would double the presence). `discordRpPrefs.transport` (default `"plugin"`) gates everything in the background — the relay's `onMessageExternal` poll answers `{}` unless relay is chosen, and the plugin push only fires on plugin.

- **`plugin` (default, cross-platform):** a custom Vencord plugin ("Rich Presence for browser extensions") runs a localhost http server on **127.0.0.1:6473**; the background SW POSTs `{ application_id, activity }` to it (`lib/presence/discord-plugin.ts → pushToPlugin`), and the plugin sets the presence via Discord internals (`FluxDispatcher LOCAL_ACTIVITY_UPDATE`). **No separate app, works on Apple Silicon** (it's injected JS in Discord, not a binary). Push-based + focus-aware: we push on every `reportPresence` and on `tabs.onActivated` (so it tracks the focused tab like the relay's poll did). The plugin lives in `~/projects/dev/Vencord` (separate repo), not here. Activity shape differs from the relay: timestamps in **ms** (not seconds), `assets.large_image` (nested), `status_display_type: 2` for the member-list title.
- **`relay` (alternative):** lolamtisch's relay extension + Node helper, the original path (pull-based, `discord-relay.ts`). Kept for setups already using it. Its prebuilt helper is x64-only → the reason the plugin path exists.

### Setup (for the user)
1. Create a Discord application at https://discord.com/developers; put its id in `WXT_DISCORD_CLIENT_ID` (`.env`).
2. On that app's **Rich Presence → Art Assets**, upload one image named exactly `tmsync` — the fallback large image when an item has no poster (per-title posters are fetched automatically; no small/play/pause assets are used anymore).
3. Pick a transport in options and run its helper:
   - **Vencord plugin** (recommended): install the "Rich Presence for browser extensions" plugin in Vencord (listens on 127.0.0.1:6473).
   - **Relay**: install lolamtisch's relay extension + run its Node helper (Apple Silicon: `git clone … && npm install && node server.js` — the packaged binary is x64-only).
4. Options → Display → Experimental → enable **Discord Rich Presence** + choose the transport.

### Presentation decisions (settled with the owner — do not relitigate)
- **The member-list line shows the TITLE, via `status_display_type: 2`.** This is the documented activity field that picks what the compact member-list/status text shows: `0` = Name (the app name "TMSync"), `1` = State, `2` = **Details** (our `details` = the title). We send `2`, so the member list reads "The Sopranos", not "TMSync". The legacy `SET_ACTIVITY` RPC the relay calls **does** honor it (verified live) — no Social SDK needed; it spreads through `@xhayper`'s `setActivity` untouched. (Dead ends ruled out first, for the record: it is NOT activity type — `type: 2` "Listening" only changed the verb/icon + added a duplicate line; and it is NOT Spotify-style sync fields — `id`/`sync_id`/`flags`/`party` reached Discord and did nothing. Found the real field via `norinorin/anime_rpc`, which uses it for exactly this.) Activity stays `type: 3` ("Watching") for the correct verb + TV icon.
- **Layout:** `details` = resolved title (line 1, also the member-list text), `state` = episode "S1E1"/"Episode 7" on its own line (omitted for movies — no tracker label, no "Paused" prefix), `largeImageKey` = poster, `largeImageText` (hover) = the title. **No buttons, no small image** — both were removed at the owner's request (the button plumbing/`link` is gone; only `slug`/`tmdbId` remain on the identity, and `tmdbId` is what the poster needs).
- **Pause keeps the card with a "⏸ Paused" label.** Discord shows a built-in elapsed timer on ANY visible activity card that lacks play-position timestamps (confirmed it's Discord, not the relay — `Extension/background.js` only sanitizes), and the seek bar **can't be frozen** (Discord animates it from the wall-clock; re-sending each poll would make it jump every ~15 s). So on pause we drop the bar and put **"⏸ Paused · ‹episode›"** on line 2 (above the timer) to label the elapsed counter. `details` stays the clean title, so the member-list line stays clean. A ~15 s relay poll lag means the playing bar keeps animating for up to ~15 s after you pause, before the paused state lands.
- **Resolved title + poster are enriched in the BACKGROUND, keyed by tabId** (`presenceExtras` store, written by `resolveMedia`, merged in the `reportPresence` handler). This is deliberate: the frame that reports presence is the one that owns the `<video>`, which on many sites is a **cross-origin player iframe** that never resolved anything itself. Threading it through the content frame only worked same-frame; doing it in the background fixes both. So a TMDB-id-only recipe ("TMDB 1398") and iframe-player sites alike show the real "The Sopranos" + poster.
- **Posters are real.** `largeImageKey` is a per-title poster URL: AniList `coverImage` (free, in the same search query) and Trakt via a **TMDB** poster lookup (`lib/trakt/images.ts`, cached). TMDB is display-only — never a tracker (constraint #1) — and gated on an optional `WXT_TMDB_API_KEY`; without it, Trakt RP falls back to the bundled `tmsync` asset (AniList still works). Discord renders the `https://` image URLs directly. The lookup runs in the background's `resolveMedia` handler, so the scrobble hot path never does the TMDB fetch. Resolution caches are versioned (`_v2`) so pre-existing entries re-resolve with the new fields (`tmdbId`/`coverUrl`).
- Registration robustness leans on "re-register when playback starts"; a relay that reloads mid-watch with nothing playing won't be re-registered until the next play. Acceptable for experimental.
