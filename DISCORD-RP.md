# Discord Rich Presence — decision note

**Status: DEFERRED — not on the roadmap (decided 2026-06-29).**
At most a future *experimental, opt-in, power-user* toggle. Do not build as a shipped feature without revisiting this note. Captured so the research isn't lost.

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

## Recommendation
**Don't build it.** It's a social-flex add-on tangential to the passive-scrobbler core, and its entire viability is hostage to a third-party helper that's broken on the owner's own platform.

If ever revisited: ship **A** as an explicitly **experimental, off-by-default** toggle (docs: "needs lolamtisch's relay + helper; Apple Silicon → run helper from source"), and route it through an internal **`PresenceSink` seam** so TMSync is coupled to its *own* neutral session-presence event, not to lolamtisch's extension directly — making any future bridge a ~30-line adapter swap rather than a rewrite. Do **not** build B (own native host) or a PreMiD plugin.
