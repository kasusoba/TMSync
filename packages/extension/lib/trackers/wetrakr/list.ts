/**
 * WeTrakr's list for list sync: shows with their status and watched episodes,
 * movies watched, planned, or dropped, and ratings, as `ListEntry` values. Like
 * Trakt, an item that is only rated or planned is still an entry. Sync treats
 * WeTrakr as a seasoned tracker: nothing is removed, so its plays are never
 * deleted.
 */
import { z } from "zod";
import {
  type ListCache,
  type ListRead,
  newCache,
  readFrom,
  savedParts,
} from "../../sync/list-cache";
import { ms, newest, num, parseEach } from "../../sync/read-util";
import type { ListEntry, SyncIds, SyncKind } from "../../sync/types";
import type { CourStatus } from "../cour-plan";
import { type WetrakrListDump, readWetrakrActivity, readWetrakrList, yearOf } from "./client";

/** A WeTrakr tracking list as a status. `waiting` (caught up, the show still
 * airing) is watching too. */
export const WETRAKR_TO_COUR: Record<string, CourStatus> = {
  watching: "CURRENT",
  waiting: "CURRENT",
  watched: "COMPLETED",
  paused: "PAUSED",
  dropped: "DROPPED",
  planning: "PLANNING",
};

const Ids = z
  .object({
    tmdb: z.union([z.number(), z.string()]).nullish(),
    imdb: z.string().nullish(),
    tvdb: z.union([z.number(), z.string()]).nullish(),
  })
  .partial();

const UserRating = z.object({
  interactions: z
    .object({
      user: z
        .object({ rating: z.object({ rating: z.number(), rated_at: z.string().nullish() }) })
        .partial(),
    })
    .partial()
    .nullish(),
});

const Media = z
  .object({
    id: z.number(),
    title: z.string().nullish(),
    ids: Ids.nullish(),
    release_date: z.string().nullish(),
    first_air_date: z.string().nullish(),
    watched_at: z.string().nullish(),
    /** The tracking list the row came from (the reader adds it). */
    list: z.string().nullish(),
    tracked_at: z.string().nullish(),
  })
  .merge(UserRating);

const EpisodePlay = z.object({
  show_id: z.number(),
  show_ids: Ids.nullish(),
  season_number: z.number(),
  number: z.number(),
  watched_at: z.string().nullish(),
});

const RatedSeason = z.object({ media_id: z.number(), number: z.number() }).merge(UserRating);

function ids(raw: z.infer<typeof Ids> | null | undefined): SyncIds {
  const out: SyncIds = {};
  const tmdb = num(raw?.tmdb ?? undefined);
  const tvdb = num(raw?.tvdb ?? undefined);
  if (tmdb) out.tmdb = tmdb;
  if (tvdb) out.tvdb = tvdb;
  if (raw?.imdb) out.imdb = raw.imdb;
  return out;
}

/** A rating on WeTrakr's 0 to 10 scale (one decimal) as 0 to 100. */
const score = (r: number) => Math.round(r * 10);

/** Turn what WeTrakr returned into list entries. Pure. */
export function wetrakrEntries(dump: WetrakrListDump): ListEntry[] {
  type Show = Extract<ListEntry, { shape: "seasons" }>;
  type Movie = Extract<ListEntry, { shape: "movie" }>;
  const shows = new Map<number, Show>();
  const movies = new Map<number, Movie>();
  const show = (
    id: number,
    title?: string | null,
    raw?: z.infer<typeof Ids> | null,
    year?: number,
  ) => {
    let e = shows.get(id);
    if (!e) {
      e = {
        tracker: "wetrakr",
        shape: "seasons",
        id,
        title: "",
        ids: {},
        rating: null,
        seasons: {},
      };
      shows.set(id, e);
    }
    if (title && !e.title) e.title = title;
    if (raw && !Object.keys(e.ids).length) e.ids = ids(raw);
    if (year && !e.year) e.year = year;
    return e;
  };
  const movie = (m: z.infer<typeof Media>) => {
    let e = movies.get(m.id);
    if (!e) {
      e = {
        tracker: "wetrakr",
        shape: "movie",
        id: m.id,
        title: m.title ?? "",
        year: yearOf(m.release_date ?? undefined),
        ids: ids(m.ids),
        rating: null,
        watched: false,
      };
      movies.set(m.id, e);
    }
    return e;
  };

  // A caught-up show can sit in both `waiting` and `watched`: any list but
  // `watched` is its status.
  const setStatus = (
    e: { status?: CourStatus | null; updatedAt?: number },
    m: z.infer<typeof Media>,
  ) => {
    const status = m.list ? WETRAKR_TO_COUR[m.list] : undefined;
    if (!status || (e.status && status === "COMPLETED")) return;
    e.status = status;
    e.updatedAt = newest(e.updatedAt, ms(m.tracked_at));
  };
  for (const m of parseEach(Media, dump.shows)) {
    const e = show(m.id, m.title, m.ids, yearOf(m.first_air_date ?? m.release_date ?? undefined));
    setStatus(e, m);
  }
  for (const p of parseEach(EpisodePlay, dump.episodePlays)) {
    const e = show(p.show_id, undefined, p.show_ids);
    const eps = e.seasons[p.season_number] ?? [];
    if (!eps.includes(p.number)) e.seasons[p.season_number] = [...eps, p.number];
    e.updatedAt = newest(e.updatedAt, ms(p.watched_at));
    e.watchedAt = newest(e.watchedAt, ms(p.watched_at));
  }
  for (const m of parseEach(Media, dump.movies)) {
    const e = movie(m);
    e.watched = true;
    e.status ??= "COMPLETED";
    e.updatedAt = newest(e.updatedAt, ms(m.watched_at));
    e.watchedAt = newest(e.watchedAt, ms(m.watched_at));
  }
  for (const m of parseEach(Media, dump.movieStatus ?? [])) setStatus(movie(m), m);
  for (const m of parseEach(Media, dump.showRatings)) {
    const r = m.interactions?.user?.rating;
    if (!r) continue;
    const e = show(m.id, m.title, m.ids, yearOf(m.first_air_date ?? undefined));
    e.rating = score(r.rating);
    e.updatedAt = newest(e.updatedAt, ms(r.rated_at));
  }
  for (const s of parseEach(RatedSeason, dump.seasonRatings)) {
    const r = s.interactions?.user?.rating;
    if (!r) continue;
    const e = show(s.media_id);
    e.seasonRatings = { ...e.seasonRatings, [s.number]: score(r.rating) };
  }
  for (const m of parseEach(Media, dump.movieRatings)) {
    const r = m.interactions?.user?.rating;
    if (!r) continue;
    const e = movie(m);
    e.rating = score(r.rating);
    e.updatedAt = newest(e.updatedAt, ms(r.rated_at));
  }
  for (const e of shows.values()) {
    for (const eps of Object.values(e.seasons)) eps.sort((a, b) => a - b);
  }
  // A show known only from a season rating has no title or ids: nothing can match it.
  return [
    ...[...shows.values()].filter((e) => e.title || Object.keys(e.ids).length),
    ...movies.values(),
  ];
}

type WetrakrPart = "shows" | "movies";
const wetrakrPart = (e: ListEntry): WetrakrPart => (e.shape === "movie" ? "movies" : "shows");

/** WeTrakr's newest change stamp, or null when it cannot be read. `all` moves on
 * any change, so it may read when nothing in the list moved, but never misses one. */
export function wetrakrStamp(raw: unknown): string | null {
  const r = z.object({ all: z.string() }).safeParse(raw);
  return r.success ? r.data.all : null;
}

/**
 * Read only what the chosen kinds need. With a saved list, ask the activity stamp
 * first and reuse the parts it covers when it did not move (WeTrakr's terms ask
 * for exactly this before a list is read again).
 */
export async function readWetrakrEntries(
  kinds: SyncKind[],
  saved?: ListCache | null,
): Promise<ListRead> {
  const anime = kinds.includes("anime");
  const parts: WetrakrPart[] = [];
  if (anime || kinds.includes("tv")) parts.push("shows");
  if (anime || kinds.includes("movie")) parts.push("movies");

  const stamp = await readWetrakrActivity().then(wetrakrStamp, () => null);
  const old = savedParts(saved, wetrakrPart);
  const reuse = parts.filter((p) => stamp && old && saved?.stamps[p] === stamp);
  const stale = parts.filter((p) => !reuse.includes(p));
  const fresh = stale.length
    ? wetrakrEntries(
        await readWetrakrList({ shows: stale.includes("shows"), movies: stale.includes("movies") }),
      )
    : [];
  const entries = [...reuse.flatMap((p) => old?.get(p) ?? []), ...fresh];
  return {
    entries,
    cache: newCache(Object.fromEntries(parts.map((p) => [p, stamp])), entries, Date.now()),
    from: readFrom({ saved: reuse.length, changes: 0, full: stale.length }),
  };
}
