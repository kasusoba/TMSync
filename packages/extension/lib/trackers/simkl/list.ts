/**
 * Simkl's list for list sync. Simkl splits its library in three: `movies`,
 * `shows` (seasons and episodes, like Trakt), and `anime` (one entry per cour,
 * AniDB numbering, carrying mal and anilist ids). So shows read as `seasons`
 * entries and anime as `cour` entries.
 */
import { z } from "zod";
import { ms, newest, num, parseEach } from "../../sync/read";
import type { ListEntry, SyncIds } from "../../sync/types";
import type { CourStatus } from "../cour-plan";
import { readSimklList } from "./client";

const Id = z.union([z.string(), z.number()]).nullish();
const Media = z.object({
  title: z.string().nullish(),
  year: z.number().nullish(),
  ids: z.object({
    simkl: z.number(),
    tmdb: Id,
    imdb: z.string().nullish(),
    tvdb: Id,
    mal: Id,
    anilist: Id,
  }),
});
const SimklStatus = z.enum(["watching", "plantowatch", "hold", "dropped", "completed"]);
const Base = z.object({
  status: SimklStatus.nullish(),
  user_rating: z.number().nullish(),
  user_rated_at: z.string().nullish(),
  last_watched_at: z.string().nullish(),
  added_to_watchlist_at: z.string().nullish(),
});
const Show = Base.extend({
  show: Media,
  watched_episodes_count: z.number().nullish(),
  total_episodes_count: z.number().nullish(),
  anime_type: z.string().nullish(),
  seasons: z
    .array(
      z.object({
        number: z.number(),
        episodes: z.array(z.object({ number: z.number() })).default([]),
      }),
    )
    .nullish(),
});
const Movie = Base.extend({ movie: Media });

const STATUS: Record<z.infer<typeof SimklStatus>, CourStatus> = {
  watching: "CURRENT",
  plantowatch: "PLANNING",
  hold: "PAUSED",
  dropped: "DROPPED",
  completed: "COMPLETED",
};

// Simkl's "watched long ago, date unknown" placeholder sits near 1970.
const realTime = (iso: string | null | undefined) => {
  const t = ms(iso);
  return t !== undefined && t > Date.UTC(2000, 0, 1) ? t : undefined;
};

function ids(m: z.infer<typeof Media>): SyncIds {
  const out: SyncIds = {};
  for (const k of ["tmdb", "tvdb", "mal", "anilist"] as const) {
    const v = num(m.ids[k]);
    if (v) out[k] = v;
  }
  if (m.ids.imdb) out.imdb = m.ids.imdb;
  return out;
}

function common(b: z.infer<typeof Base>, m: z.infer<typeof Media>) {
  return {
    tracker: "simkl" as const,
    id: m.ids.simkl,
    title: m.title ?? "",
    year: m.year ?? undefined,
    ids: ids(m),
    rating: b.user_rating ? b.user_rating * 10 : null,
    updatedAt: newest(
      realTime(b.last_watched_at),
      realTime(b.user_rated_at),
      realTime(b.added_to_watchlist_at),
    ),
    status: b.status ? STATUS[b.status] : null,
  };
}

/** Turn a `/sync/all-items` reply into list entries. Pure. */
export function simklEntries(raw: unknown): ListEntry[] {
  const doc = z
    .object({
      shows: z.array(z.unknown()).nullish(),
      anime: z.array(z.unknown()).nullish(),
      movies: z.array(z.unknown()).nullish(),
    })
    .safeParse(raw);
  if (!doc.success) return [];
  const out: ListEntry[] = [];
  for (const s of parseEach(Show, doc.data.shows ?? [])) {
    const seasons: Record<number, number[]> = {};
    for (const season of s.seasons ?? [])
      seasons[season.number] = season.episodes.map((e) => e.number);
    out.push({ ...common(s, s.show), shape: "seasons", seasons });
  }
  for (const a of parseEach(Show, doc.data.anime ?? [])) {
    const c = common(a, a.show);
    const movie = a.anime_type === "movie";
    out.push({
      ...c,
      shape: "cour",
      progress: movie ? (c.status === "COMPLETED" ? 1 : 0) : (a.watched_episodes_count ?? 0),
      total: movie ? 1 : a.total_episodes_count ? a.total_episodes_count : null,
      repeat: 0,
      movie,
    });
  }
  for (const m of parseEach(Movie, doc.data.movies ?? [])) {
    const c = common(m, m.movie);
    out.push({ ...c, shape: "movie", watched: m.status === "completed" });
  }
  return out;
}

export async function readSimklEntries(): Promise<ListEntry[]> {
  return simklEntries(await readSimklList());
}
