import type { PresenceState } from "./types";

/** Fallback large-image key when no poster is resolved (a named art asset on the
 * Discord application; falls back to the app's default icon if the app has none). */
const LARGE_IMAGE = "tmsync";

/**
 * Build the Discord activity object from TMSync's neutral {@link PresenceState}.
 * The transport-agnostic mapping (kept separate from the aura POST so a future
 * transport reuses it verbatim), producing:
 *  - timestamps in **milliseconds** (gateway/local-activity path, not RPC seconds);
 *  - assets nested (`assets.large_image`) — the receiver resolves a URL (our poster)
 *    or a named key;
 *  - `status_display_type: 2` (Details) makes the member-list line show the title.
 */
export function toActivity(state: PresenceState): Record<string, unknown> {
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
