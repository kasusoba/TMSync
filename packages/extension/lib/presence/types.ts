/**
 * TMSync's OWN neutral session-presence event — the seam (see docs/DISCORD-RP.md).
 * The content session produces this as a side effect of scrobbling; a PresenceSink
 * translates it to a concrete transport (today: the lolamtisch Discord relay). We
 * couple to THIS shape, never to a specific transport, so a future bridge is a
 * small adapter swap rather than a rewrite.
 */
export interface PresenceState {
  /** Line 1 — the resolved title (e.g. "Frieren"). */
  title: string;
  /** Line 2 — "S2E5" / "Episode 7"; omitted for movies. */
  subtitle?: string;
  paused: boolean;
  /** Epoch ms for the live elapsed/remaining bar. Omitted while paused. */
  startEpochMs?: number;
  endEpochMs?: number;
  /** Poster/cover image URL for the large image (AniList cover / TMDB poster).
   * Falls back to the bundled brand asset when absent. */
  posterUrl?: string;
}
