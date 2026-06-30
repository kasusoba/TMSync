import { DISCORD, PLUGIN_URL } from "./config";
import type { PresenceState } from "./types";

const LARGE_IMAGE = "tmsync";

/**
 * Build the Discord gateway-activity object the Vencord plugin dispatches via
 * `LOCAL_ACTIVITY_UPDATE`. Two differences from the relay/RPC shape (discord-relay.ts):
 *  - timestamps are in **milliseconds** here (gateway/local), not seconds (RPC);
 *  - assets are nested (`assets.large_image`) — the plugin resolves it via
 *    `fetchAssetIds`, which accepts either a URL (our poster) or a named key.
 * `status_display_type: 2` (Details) makes the member-list line show the title.
 */
function toActivity(state: PresenceState): Record<string, unknown> {
  const activity: Record<string, unknown> = {
    type: 3, // Watching
    name: "TMSync",
    details: state.title,
    assets: { large_image: state.posterUrl ?? LARGE_IMAGE, large_text: state.title },
    status_display_type: 2,
    flags: 1, // INSTANCE
  };
  // Episode on its own line, with a "Paused" marker on pause (no frozen bar possible).
  if (state.paused) {
    activity.state = state.subtitle ? `⏸ Paused · ${state.subtitle}` : "⏸ Paused";
  } else if (state.subtitle) {
    activity.state = state.subtitle;
  }
  // Live bar only while playing — milliseconds for the local-activity path.
  if (!state.paused && state.startEpochMs !== undefined) {
    activity.timestamps = {
      start: state.startEpochMs,
      ...(state.endEpochMs !== undefined ? { end: state.endEpochMs } : {}),
    };
  }
  return activity;
}

/**
 * Push presence to the local Vencord "Rich Presence for browser extensions" plugin
 * (docs/DISCORD-RP.md) — the cross-platform alternative to the lolamtisch relay
 * (no native helper, so Apple Silicon works). `null` clears it. Best-effort: if
 * Discord/the plugin isn't running the fetch just fails and we stay inert. Runs
 * from the background SW, which can reach `http://localhost` with the host
 * permission (CORS doesn't apply to SW fetches).
 */
export async function pushToPlugin(state: PresenceState | null): Promise<void> {
  if (!DISCORD.clientId) return;
  try {
    await fetch(PLUGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        application_id: DISCORD.clientId,
        activity: state ? toActivity(state) : null,
      }),
    });
  } catch {
    // plugin not running / Discord closed — inert
  }
}
