/** Plain-text descriptions of list sync writes and entries, for the preview. Pure. */
import type { CourStatus } from "../trackers/cour-plan";
import { outOfTen } from "./score";
import type { EntryState, SyncWrite } from "./types";

export const STATUS_LABEL: Record<CourStatus, string> = {
  CURRENT: "Watching",
  PLANNING: "Plan to watch",
  COMPLETED: "Completed",
  PAUSED: "Paused",
  DROPPED: "Dropped",
  REPEATING: "Rewatching",
};

/** What an entry held, in a few words: "Plan to watch · 3/12 eps · rated 8/10". */
export function describeState(s: EntryState): string {
  const parts: string[] = [];
  if (s.status) parts.push(STATUS_LABEL[s.status]);
  if (s.progress !== undefined) parts.push(`${s.progress}/${s.total ?? "?"} eps`);
  if (s.episodes !== undefined) parts.push(`${s.episodes} watched`);
  if (s.watched !== undefined && !s.status) parts.push(s.watched ? "watched" : "not watched");
  if (s.rating != null) parts.push(`rated ${outOfTen(s.rating)}/10`);
  return parts.join(" · ") || "on the list";
}

/** One line of what a write does, for the preview. Each says what the tracker has
 * now ("had", "was"), so a change is never a surprise. */
export function describeWrite(w: SyncWrite): string {
  switch (w.op) {
    case "episodes": {
      const add = `+${w.add.length} episode${w.add.length === 1 ? "" : "s"}`;
      return w.was ? `${add} · had ${w.was.episodes ?? 0}` : `${add} · new`;
    }
    case "movie":
      return w.was?.status ? `mark watched · was ${STATUS_LABEL[w.was.status]}` : "mark watched";
    case "remove":
      return `remove · was ${describeState(w.was)}`;
    case "rating":
      return `rate ${outOfTen(w.score)}/10${w.level === "season" ? ` (season ${w.season})` : ""}${w.picked ? " · your pick" : ""}`;
    case "unrate":
      return `remove rating${w.level === "season" ? ` (season ${w.season})` : ""} · was ${outOfTen(w.was)}/10`;
    case "entry": {
      const parts: string[] = [w.create ? "add" : "update"];
      if (w.progress) parts.push(`${w.progress.from} → ${w.progress.to} eps`);
      if (w.status?.to) {
        parts.push(
          w.status.from
            ? `${STATUS_LABEL[w.status.from]} → ${STATUS_LABEL[w.status.to]}`
            : STATUS_LABEL[w.status.to],
        );
      }
      if (w.repeat) parts.push(`${w.repeat.to} rewatches`);
      return parts.join(" · ");
    }
  }
}
