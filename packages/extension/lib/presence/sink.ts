import type { PresenceState } from "./types";

/**
 * The presence-transport seam. TMSync emits a neutral {@link PresenceState}; a
 * PresenceSink (today only the Discord relay) registers with its transport and
 * answers each poll. Keeping this interface between the session and lolamtisch's
 * relay is the whole point of the seam — see docs/DISCORD-RP.md "Recommendation".
 */
export interface PresenceSink {
  /** Announce TMSync to the transport so it starts polling us. Idempotent. */
  register(): Promise<void>;
  /**
   * Translate the current neutral state (or null = nothing to show) into the
   * transport's poll reply. Pure — returns the object handed straight back to the
   * relay's `sendResponse`. `null` ⇒ an empty reply that keeps us registered but
   * displays nothing.
   */
  poll(state: PresenceState | null): unknown;
}
