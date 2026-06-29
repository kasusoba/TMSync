# Storage, sync & portability — design note

How TMSync user data is layered, what crosses devices, and how that stays consistent with the repo (central DB) and constraint #7 (no backend in v1). This is the reference for the portability work (export/import → browser sync → crosswalk).

## The one-sentence model
**Export bundle === sync payload === "your user-owned deltas."** Library content comes from the repo (same on every device, never synced or exported); local content never travels (except the crosswalk rides along in the manual export). Hold this line and the repo-vs-sync interaction can never carry the same data twice.

## Three layers, one merge
| Layer | What | Storage | Travels? |
|---|---|---|---|
| **Library** (central DB / repo JSON) | shared recipes + quicklink templates, PR-contributed; `source: "library"` | fetched per-device (`local:remote_recipes` cache) | ❌ never — each device fetches the repo itself |
| **Sync** (your deltas) | custom recipes, user quicklinks, corrections, manual picks, + your toggles on library items | `browser.storage.sync` | ✅ the only synced layer |
| **Local** (this device) | tokens (secrets), resolution/rating caches, rating+note mirrors, enabled_origins (permission state), crosswalk | `local:` | ❌ regenerable or sensitive |

**Merge (read-time, deterministic):** `effective = library (minus user-disabled) + user items`. User data always wins; a library refresh never clobbers user data; a library item removed upstream just orphans a harmless toggle. The existing `source: "library" | "user"` field is the discriminator — lean on it.

## Storage key classification (target)
**Sync layer** (`sync:`, user-owned, per-item keyed):
- `custom_recipes` → one key per recipe (`sync:recipe:{id}`)
- `quick_links` where `source: "user"` (full) + toggle state (`enabled`) for `source: "library"` ones
- `corrections`, `manual_selections` (capped / LRU)
- `badge_prefs` (already `sync:`)

**Library layer** (from repo, never synced): `remote_recipes`; library quicklink templates.

**Local layer** (never synced): `trakt_tokens`, `anilist_tokens` (secrets — never sync), `resolution_cache`, `anilist_resolution_cache`, `remote_ratings`, `ratings`/`notes`/`anilist_ratings`/`anilist_notes` (mirrors; tracker is source of truth — owner chose not to sync these), `enabled_origins` (per-device permission state), the future **crosswalk**, all `session:*`.

## browser.storage.sync — the no-backend cross-device path
It's the *browser vendor's* sync (Google/Firefox account), **not** a TMSync backend → constraint #7 holds. Already in use for `badge_prefs`. Constraints that shape the design:

1. **Quota: 100 KB total · 8 KB per item · 512 items · write-rate caps.** ⇒ never store one growing array under a single key — use **per-item keys**; cap/LRU growth-prone sets (corrections).
2. **Best-effort.** Only active when the user is signed into the browser with sync on; otherwise silently local. ⇒ Export/Import is the universal fallback, not optional.
3. **Host permissions don't sync** (constraint #5 — per-device, user-gesture grants). ⇒ synced config drives a *"these sites are set up on your other device — click to enable here"* one-click re-grant; `enabled_origins` itself stays local (it reflects actual grants on this device).
4. **Last-write-wins per item** across devices (browser.sync default) — acceptable.
5. **Migration:** none for now. Early stage / single user with a handful of entries → the owner accepts wiping and recreating, so flipping the key from `local:` to `sync:` (which orphans the old `local:` data) is fine. A one-time `local → sync` copy-up can be added later if needed.

## Export / Import (manual portability)
- Serializes the **Sync layer** (user deltas) + the crosswalk — explicitly **not** library (re-fetched) and **not** tokens/caches.
- Import merges into the sync layer (user-wins, dedupe by id). Same data set as auto-sync → one mental model.
- This is the immediate fix for "my config is on the PC, I'm on the laptop": export from PC, import on laptop. Works with or without browser sync.

## Crosswalk placement (the quicklink "correct page" feature)
The `(site, anilistId) → real slug/canonical URL` map captured at resolve/watch time:
- **Local** for v1 (grows with watching → quota-risky; regenerable on next visit).
- **Included in the manual export** (so it can ride to another device).
- Revisit syncing a **capped recent subset** later if it proves valuable.

## Contribution & graduation (recipes/quicklinks → central DB)
Goal: a contributed item is **merge-ready** — lands in the right repo file with no collision/overwrite, so acceptance is mechanical (ideally a bot opens the PR; a human only approves). Decided 2026-06-29.

**Only site config is contributable.** `recipe` and `quicklink` only. **Corrections, manual picks, and the crosswalk are NEVER contributed** — they reveal what the user watched (constraint #6). "Contribute all" = all your recipes + quicklinks, nothing watch-revealing.

**Client emits a self-describing, pre-cleaned payload** into a prefilled GitHub issue (`issues/new?title=…&body=…`), single-click, uses the user's GitHub login — no backend (constraint #7):
```json
{ "kind": "recipe", "tracker": "trakt", "action": "add",
  "id": "cineby", "schemaVersion": 2, "data": { …canonical schema fields only… } }
```
- routing is in the payload: `trakt → recipes/trakt/`, `anilist → recipes/anime/`, `quicklink → links index`
- strip local-only fields (`source`, `enabled`) → already library-shaped, nothing to clean
- **stable unique id** — both for no-collision placement AND so the local copy graduates cleanly later (same requirement)
- contribute-all with many items exceeds the issue-URL length → fall back to copy-all-JSON + open the contribute page

**Repo side: a GitHub Action (issue → PR bot)** parses the wrapper → Zod-validates → biome-formats → routes to the correct file → **add** (new id) vs **update** (existing id, explicit flag; a *foreign-author* update is held for human review, never silent) → opens a lint-clean, correctly-placed PR. This is **repo CI automation, not a hosted backend** (no server/DB, no user data, no watch history) → within constraint #7's spirit, and **optional** (without it, a human converts the issue).

**No-overlap / no-overwrite** comes from: unique ids · explicit add-vs-update (never silent) · CI owns all formatting & placement (no manual JSON pass).

**Graduation (decided — "auto-graduate, keep my toggle"):** the library preserves the contributed id, so on the next refresh the same-id library copy **collapses** the local user copy — library content wins, the user's enable/disable toggle carries over, sync quota is freed. If the user edited their copy after contributing (or a maintainer changed it in review), the local copy **shadows** the library one (user-wins) and shows an "adopt library version?" nudge. Rejected contributions change nothing (stays user-owned).

## Sequencing (decided 2026-06-29)
1. **Export/Import JSON** — fastest relief, universal, defines the "user deltas" set concretely.
2. **Migrate user-authored config to `browser.storage.sync`** — DONE (2026-06-29): flipped `custom_recipes`, `quick_links`, `corrections`, `manual_selections` to `sync:` single keys (no migration shim — accepted wipe at this stage). Sync set: **custom recipes, quicklinks, corrections, manual picks** (not rating/note mirrors). Follow-ups (deferred): per-item keys for quota safety + a "set up these sites here" re-grant prompt (host permissions don't sync).
3. **Build the crosswalk** (recipe-canonical-id capture + local map + smarter `{slug}` source) on the finalized storage model.
