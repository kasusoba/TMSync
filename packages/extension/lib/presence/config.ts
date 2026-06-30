/**
 * Discord Rich Presence config (experimental — docs/DISCORD-RP.md).
 *
 * A browser extension cannot open Discord's local IPC socket, so true RP needs a
 * native helper. The only helper reachable FROM an extension is lolamtisch's
 * "Discord Rich Presence" relay — we talk to it via cross-extension messaging, it
 * forwards to its Node helper, which does the IPC. We register a TMSync Discord
 * application for the clientId + art (bundled, no backend — like the Trakt/AniList
 * client ids). Missing clientId ⇒ the feature is inert and the UI explains why.
 */
export const DISCORD = {
  clientId: import.meta.env.WXT_DISCORD_CLIENT_ID,
} as const;

/**
 * lolamtisch's relay extension id (docs/DISCORD-RP.md "Options surveyed" → A).
 * Chrome and Firefox ship under different ids; the relay's public API (the
 * cross-extension messaging door, not a host-locked allowlist) accepts any
 * data-extension, so no special handshake beyond knowing the id.
 */
export const RELAY_ID =
  import.meta.env.BROWSER === "firefox"
    ? "{57081fef-67b4-482f-bcb0-69296e63ec4f}"
    : "agnaejlkbiiggajjmnpmeheigkflbnoo";

/**
 * The local "Rich Presence for browser extensions" Vencord plugin endpoint (its
 * native http server). This is the cross-platform alternative to the lolamtisch
 * relay: no native helper app, so it works on Apple Silicon (the relay's prebuilt
 * helper does not). We POST `{ application_id, activity }` here; the plugin sets
 * the presence via Discord internals. Bind address is 127.0.0.1 (the plugin's).
 */
export const PLUGIN_URL = "http://127.0.0.1:6473";

/** Whether a Discord application clientId is bundled at all (so the UI can explain). */
export const presenceConfigured = (): boolean => !!DISCORD.clientId;
