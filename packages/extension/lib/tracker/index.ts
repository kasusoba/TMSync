import { anilistAdapter } from "../anilist/adapter";
import { traktAdapter } from "../trakt/adapter";
import type { TrackerAdapter } from "./adapter";
import type { Tracker } from "./types";

export type { TrackerAdapter } from "./adapter";
export type { RatingLevel, RecordPhase, RecordResult, Tracker, TrackedItem } from "./types";

/** The adapter for a tracker. Routing's single source of truth (constraint #1). */
export function getAdapter(tracker: Tracker): TrackerAdapter {
  return tracker === "anilist" ? anilistAdapter : traktAdapter;
}
