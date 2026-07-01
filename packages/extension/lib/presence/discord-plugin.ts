import { toActivity } from "./activity";
import { DISCORD, PLUGIN_URL } from "./config";
import type { PresenceState } from "./types";

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
