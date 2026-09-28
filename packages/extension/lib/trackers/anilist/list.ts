/** AniList's list for list sync: one cour entry per anime on the viewer's list. */
import { z } from "zod";
import { parseEach } from "../../sync/read";
import type { ListEntry } from "../../sync/types";
import type { CourStatus } from "../cour-plan";
import type { ScoreFormat } from "../types";
import { readAniListList } from "./client";

const Status = z.enum(["CURRENT", "PLANNING", "COMPLETED", "DROPPED", "PAUSED", "REPEATING"]);

const Entry = z.object({
  mediaId: z.number(),
  status: Status.nullish(),
  progress: z.number().nullish(),
  repeat: z.number().nullish(),
  private: z.boolean().nullish(),
  updatedAt: z.number().nullish(),
  score: z.number().nullish(),
  media: z.object({
    idMal: z.number().nullish(),
    episodes: z.number().nullish(),
    format: z.string().nullish(),
    isAdult: z.boolean().nullish(),
    startDate: z.object({ year: z.number().nullish() }).nullish(),
    title: z.object({ userPreferred: z.string().nullish() }).nullish(),
  }),
});

/** Turn AniList list entries into list entries. `score` is already 0 to 100
 * (read with `format: POINT_100`), 0 = not scored. Pure. */
export function anilistEntries(raw: unknown[]): ListEntry[] {
  return parseEach(Entry, raw).map((e) => ({
    tracker: "anilist",
    shape: "cour",
    id: e.mediaId,
    title: e.media.title?.userPreferred ?? "",
    year: e.media.startDate?.year ?? undefined,
    ids: { anilist: e.mediaId, ...(e.media.idMal ? { mal: e.media.idMal } : {}) },
    rating: e.score ? e.score : null,
    updatedAt: e.updatedAt ? e.updatedAt * 1000 : undefined,
    private: e.private ?? false,
    adult: e.media.isAdult ?? false,
    progress: e.progress ?? 0,
    total: e.media.episodes ?? null,
    status: (e.status ?? null) as CourStatus | null,
    repeat: e.repeat ?? 0,
    movie: e.media.format === "MOVIE",
  }));
}

export async function readAniListEntries(): Promise<{
  entries: ListEntry[];
  scoreFormat: ScoreFormat | null;
}> {
  const { entries, scoreFormat } = await readAniListList();
  return { entries: anilistEntries(entries), scoreFormat };
}
