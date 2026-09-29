/** MyAnimeList's list for list sync: one cour entry per anime on the user's list. */
import { z } from "zod";
import { finishedAt, fullDay, ms, parseEach } from "../../sync/read-util";
import type { ListEntry } from "../../sync/types";
import { readMalList, toCourEntry } from "./client";
import { MAL_STATUSES } from "./types";

const Item = z.object({
  node: z.object({
    id: z.number(),
    title: z.string().nullish(),
    num_episodes: z.number().nullish(),
    media_type: z.string().nullish(),
    nsfw: z.string().nullish(),
    start_season: z.object({ year: z.number().nullish() }).nullish(),
  }),
  list_status: z.object({
    status: z.enum(MAL_STATUSES).nullish(),
    score: z.number().nullish(),
    num_episodes_watched: z.number().nullish(),
    is_rewatching: z.boolean().nullish(),
    num_times_rewatched: z.number().nullish(),
    updated_at: z.string().nullish(),
    start_date: z.string().nullish(),
    finish_date: z.string().nullish(),
  }),
});

/** Turn MAL animelist items into list entries. MAL reports 0 episodes for
 * "unknown", and a score of 0 for "not scored". Pure. */
export function malEntries(raw: unknown[]): ListEntry[] {
  return parseEach(Item, raw).map(({ node, list_status: s }) => {
    const startedOn = fullDay(s.start_date);
    const finishedOn = fullDay(s.finish_date);
    const entry = toCourEntry({
      status: s.status ?? undefined,
      num_episodes_watched: s.num_episodes_watched ?? undefined,
      is_rewatching: s.is_rewatching ?? undefined,
      num_times_rewatched: s.num_times_rewatched ?? undefined,
    });
    return {
      tracker: "mal",
      shape: "cour",
      id: node.id,
      title: node.title ?? "",
      year: node.start_season?.year ?? undefined,
      ids: { mal: node.id },
      rating: s.score ? s.score * 10 : null,
      updatedAt: ms(s.updated_at),
      watchedAt:
        (s.status === "completed" ? finishedAt(finishedOn, ms(s.updated_at)) : undefined) ??
        ms(s.updated_at),
      adult: node.nsfw === "black",
      progress: entry.progress,
      total: node.num_episodes ? node.num_episodes : null,
      status: entry.status,
      repeat: entry.repeat,
      movie: node.media_type === "movie",
      ...(startedOn ? { startedOn } : {}),
      ...(finishedOn ? { finishedOn } : {}),
    };
  });
}

export async function readMalEntries(): Promise<ListEntry[]> {
  return malEntries(await readMalList());
}
