import { auraPresence } from "@/lib/storage";
import { toActivity } from "./activity";
import type { PresenceState } from "./types";

/**
 * aura transport (docs/DISCORD-RP.md): POST presence to the user's own self-hosted
 * aura Worker, which sets it via Discord's headless-session server API — no native
 * helper, cross-device incl. mobile. Unlike the plugin/relay (localhost), aura is a
 * REMOTE user-configured endpoint + bearer token, so its origin must be granted via
 * `optional_host_permissions` (requested from the options page on a user gesture).
 *
 * The wire contract matches aura's `/presence` ingest: `{ application_id, activity }`
 * with `Authorization: Bearer <token>`; `activity: null` clears the presence. Config
 * is read from storage on every call (background is a stateless SW — constraint #4).
 * Best-effort: missing config or an unreachable endpoint just leaves presence inert.
 */
export async function pushToAura(state: PresenceState | null): Promise<void> {
  const { url, token, applicationId } = await auraPresence.getValue();
  if (!url || !token) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        application_id: applicationId,
        activity: state ? toActivity(state) : null,
      }),
    });
  } catch {
    // endpoint down / not configured — inert
  }
}
