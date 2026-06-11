import type { BadgeStatus } from "@/messaging";

/**
 * Map a scrobble status to a toolbar-icon badge (text + background colour) — the
 * ambient status surface that never touches the page. Empty text ⇒ no badge.
 * A pending prompt (pick / which-episode / rewatch) or an error shows an
 * attention glyph so the user knows to open the popup. Pure + unit-tested.
 */
export function actionBadgeFor(status: BadgeStatus | null): { text: string; color: string } {
  if (!status) return { text: "", color: "#000000" };
  // Needs your input → a question mark, whatever the underlying playback state.
  if (status.pick || status.needEpisode || status.rewatch) return { text: "?", color: "#f97316" };
  switch (status.state) {
    case "watching":
      return { text: "▶", color: "#10b981" };
    case "paused":
      return { text: "II", color: "#f59e0b" };
    case "scrobbled":
      return { text: "✓", color: "#0ea5e9" };
    case "error":
      return { text: "!", color: "#f43f5e" };
    default:
      return { text: "", color: "#000000" }; // idle / stopped — no badge
  }
}
