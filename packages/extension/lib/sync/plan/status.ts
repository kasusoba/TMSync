/**
 * Statuses on the trackers that keep watches by episode (Trakt, WeTrakr, and
 * Simkl outside anime). Each holds only some statuses and can be given fewer:
 * COMPLETED always comes from the watches, never from a status write (a bare
 * WeTrakr `watched` or Simkl `completed` would mark every episode watched).
 * Pure.
 */
import type { CourStatus } from "../../trackers/cour-plan";
import type { Tracker } from "../../trackers/types";
import type { Change } from "../types";
import type { SeasonedEntry } from "./context";
import { normStatus } from "./util";

/** What a status is on: a movie, or a whole show. */
export type StatusShape = "movie" | "show";

/** The statuses sync may write to each tracker. Trakt: the watchlist and the
 * dropped shows. A tracker not listed takes no status this way. */
const GIVES: Partial<Record<Tracker, Record<StatusShape, CourStatus[]>>> = {
  trakt: { movie: ["PLANNING"], show: ["PLANNING", "DROPPED"] },
  wetrakr: { movie: ["PLANNING", "DROPPED"], show: ["PLANNING", "CURRENT", "PAUSED", "DROPPED"] },
  simkl: { movie: ["PLANNING", "DROPPED"], show: ["PLANNING", "CURRENT", "PAUSED", "DROPPED"] },
};

export const givesStatus = (tk: Tracker, shape: StatusShape, s: CourStatus) =>
  !!GIVES[tk]?.[shape].includes(s);

/**
 * The status write a tracker needs to go from `from` to `to`, or undefined. A
 * status the tracker cannot be given still leaves the one it holds: Trakt leaves
 * the watchlist (or undrops) when the show is watched again, though it has no
 * "watching". COMPLETED is never written. Pure.
 */
export function statusChange(
  tk: Tracker,
  shape: StatusShape,
  from: CourStatus | null,
  to: CourStatus | null,
): Change<CourStatus | null> | undefined {
  if (!to || to === "COMPLETED") return undefined;
  const was = from ? normStatus(from) : null;
  if (was === to) return undefined;
  if (givesStatus(tk, shape, to)) return { from, to };
  if (was && givesStatus(tk, shape, was)) return { from, to };
  return undefined;
}

/**
 * The status a movie or show should have, from its sources (the main list, or
 * every list). The most recently changed status wins, except that a watch counts
 * too: a planned show with watches is being watched, and a show watched after it
 * was paused or dropped is being watched again. A watched movie is complete,
 * which its watch writes. `conflict` = the sources hold different statuses that
 * the watches do not explain. Pure.
 */
export function wantedStatus(
  sources: SeasonedEntry[],
  shape: StatusShape,
): { desired: CourStatus | null; latest?: SeasonedEntry; conflict: boolean } {
  const withStatus = sources
    .filter((m): m is SeasonedEntry & { status: CourStatus } => !!m.status)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const latest = withStatus[0];
  const watched = sources.some((m) =>
    m.shape === "movie" ? m.watched : Object.values(m.seasons).some((eps) => eps.length),
  );
  const lastWatch = Math.max(0, ...sources.map((m) => m.watchedAt ?? 0));
  let desired = latest ? normStatus(latest.status) : null;
  if (shape === "movie") {
    if (watched) desired = null;
  } else if (desired === "PLANNING" && watched) desired = "CURRENT";
  else if ((desired === "PAUSED" || desired === "DROPPED") && lastWatch > (latest?.updatedAt ?? 0))
    desired = "CURRENT";
  // Statuses that differ only because of the watches are no disagreement.
  const held = new Set(
    withStatus
      .map((m) => normStatus(m.status))
      .filter((s) => s !== "COMPLETED" && !(s === "PLANNING" && watched)),
  );
  return { desired, latest, conflict: desired !== null && held.size > 1 };
}
