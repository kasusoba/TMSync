import type { BadgeStatus } from "@/messaging";

/**
 * The status-dot colour overlaid on the toolbar icon for a scrobble status, or
 * null for no dot (idle / stopped — the plain brand icon). The toolbar icon is
 * the ambient status surface (the popup mirrors it); a coloured dot reads cleanly
 * at icon size, unlike a text glyph (which overflowed the badge pill). A pending
 * prompt (pick / which-episode / rewatch) is orange so it stands out. Pure +
 * unit-tested.
 */
export function statusDotColor(status: BadgeStatus | null): string | null {
  if (!status) return null;
  if (status.pick || status.needEpisode || status.rewatch) return "#f97316"; // needs you
  switch (status.state) {
    case "watching":
      return "#10b981";
    case "paused":
      return "#f59e0b";
    case "scrobbled":
      return "#0ea5e9";
    case "error":
      return "#f43f5e";
    default:
      return null; // idle / stopped — plain icon
  }
}
