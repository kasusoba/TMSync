/** Labels and text helpers the List sync pane parts share. */
import type { TrackerRead } from "@/lib/sync/preview";
import type { SkipReason, SyncKind, SyncNotice, SyncTotals } from "@/lib/sync/types";

export const KIND_LABEL: Record<SyncKind, string> = { movie: "Movies", tv: "TV", anime: "Anime" };

export const KINDS: SyncKind[] = ["movie", "tv", "anime"];

export const SKIP_LABEL: Record<SkipReason, string> = {
  ignored: "You keep these out of sync",
  private: "Private on AniList",
  adult: "Adult entries",
  ambiguous: "The crosswalk can’t pick one entry",
  not_mapped: "Not in the anime crosswalk",
  numbering: "Episode numbers don’t match",
  no_id: "No id the tracker can use",
  main_missing: "The main list wasn’t read, so nothing of this kind is planned",
};

export const NOTICE_LABEL: Record<SyncNotice["reason"], string> = {
  ahead: "Further than the main list. Sync never lowers progress.",
  history_kept: "Watch history. Sync never deletes it.",
  rating_kept: "A different rating. Sync only fills empty ratings.",
};

/** A short read, for a tracker that can tell what changed (`sync/list-cache.ts`). */
export const FROM_LABEL: Record<NonNullable<TrackerRead["from"]>, string> = {
  saved: "No changes since the last read",
  changes: "Read only what changed",
};

export const READ_LABEL: Record<TrackerRead["state"], string> = {
  waiting: "Waiting",
  reading: "Reading…",
  read: "Read",
  not_connected: "Not connected",
  off: "Off",
  failed: "Couldn’t read",
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a tracker gets, in short parts: "+12 episodes", "3 ratings". */
export function totalParts(x: SyncTotals, removals = true): string[] {
  return [
    x.episodes && `+${plural(x.episodes, "episode")}`,
    x.movies && `+${plural(x.movies, "movie")}`,
    x.created && plural(x.created, "new entry", "new entries"),
    x.updated && `${x.updated} updated`,
    x.ratings && plural(x.ratings, "rating"),
    removals && x.removed && `${x.removed} removed`,
    removals && x.unrated && `${plural(x.unrated, "rating")} removed`,
  ].filter((p): p is string => !!p);
}
