import { browser } from "wxt/browser";
import { DISCORD, RELAY_ID } from "./config";
import type { PresenceSink } from "./sink";
import type { PresenceState } from "./types";

/**
 * Brand asset key uploaded on the TMSync Discord application's Rich Presence art
 * page (Developer Portal → Rich Presence → Art Assets) — the fallback large image
 * when an item has no poster. Per-title posters (AniList cover / TMDB) are the
 * normal case; this is only the gap-filler. No small image: a play/pause overlay
 * was a confusing extra asset (docs/DISCORD-RP.md) — pause is shown in the text.
 */
const LARGE_IMAGE = "tmsync";

/**
 * Discord activity `status_display_type` (documented gateway/activity field):
 * controls WHICH field the compact member-list status text shows — 0 = Name (the
 * app name "TMSync"), 1 = State, 2 = Details. We use **2 (Details)** so the member
 * list shows the title (`details`), like the YouTube-Music / `norinorin/anime_rpc`
 * apps. The legacy `SET_ACTIVITY` RPC the relay calls DOES honor it (verified live),
 * so no Social SDK migration is needed. This is the whole reason the member-list
 * line reads "The Sopranos" instead of "TMSync".
 */
const STATUS_DISPLAY_DETAILS = 2;

/**
 * The Discord relay sink (Option A). `register()` knocks on lolamtisch's relay
 * extension via cross-extension messaging; `poll()` maps our neutral state to the
 * Discord activity shape the relay forwards verbatim to its Node helper → IPC.
 */
export const discordRelaySink: PresenceSink = {
  async register(): Promise<void> {
    if (!DISCORD.clientId) return;
    try {
      // `active` = show only while the watching tab is focused (the relay decides
      // focus); the response is irrelevant — registration is what matters.
      await browser.runtime.sendMessage(RELAY_ID, { mode: "active" });
    } catch {
      // Relay not installed / Discord helper down — the feature is simply inert.
    }
  },

  poll(state: PresenceState | null): unknown {
    // Empty object keeps us registered (the relay unregisters a listener that
    // misses a poll) while displaying nothing — paused-with-no-tab, disabled, etc.
    if (!state || !DISCORD.clientId) return {};

    const presence: Record<string, unknown> = {
      type: 3, // "Watching" — correct verb + TV icon
      details: state.title,
      // Per-title poster when we have one (Discord renders https image URLs);
      // otherwise the bundled brand asset key. Hover text is the title (not the site).
      largeImageKey: state.posterUrl ?? LARGE_IMAGE,
      largeImageText: state.title,
      // Member-list line shows `details` (the title), not the app name. Wire field
      // is snake_case; it spreads through setActivity untouched.
      status_display_type: STATUS_DISPLAY_DETAILS,
      instance: false,
    };
    // Line 2: the episode, with a "Paused" marker when paused. We can't freeze the
    // seek bar (Discord animates it from the wall-clock), and a visible card always
    // carries some timer, so on pause we drop the bar and label line 2 instead.
    // `details` stays the clean title, so the member-list line stays clean.
    if (state.paused) {
      presence.state = state.subtitle ? `⏸ Paused · ${state.subtitle}` : "⏸ Paused";
    } else if (state.subtitle) {
      presence.state = state.subtitle;
    }
    // Live progress bar only while playing.
    if (!state.paused && state.startEpochMs !== undefined) {
      presence.startTimestamp = Math.floor(state.startEpochMs / 1000);
      if (state.endEpochMs !== undefined) {
        presence.endTimestamp = Math.floor(state.endEpochMs / 1000);
      }
    }
    return { clientId: DISCORD.clientId, presence };
  },
};
