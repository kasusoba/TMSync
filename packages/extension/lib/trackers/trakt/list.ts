/**
 * Trakt's list for list sync: watched shows and movies, plus ratings, as
 * `ListEntry` values. Trakt keeps ratings apart from history, so an item that is
 * rated but not watched is still an entry (with nothing watched). Trakt has no
 * list status: completion is derived from episodes.
 */
import { z } from "zod";
import { ms, newest, num, parseEach } from "../../sync/read";
import type { ListEntry, SeasonEpisodes, SyncIds, SyncKind } from "../../sync/types";
import { type TraktListDump, readTraktList } from "./client";

const Ids = z.object({
  trakt: z.number(),
  tmdb: z.number().nullish(),
  imdb: z.string().nullish(),
  tvdb: z.number().nullish(),
});
const Media = z.object({ title: z.string().nullish(), year: z.number().nullish(), ids: Ids });

const WatchedShow = z.object({
  last_watched_at: z.string().nullish(),
  show: Media,
  seasons: z
    .array(z.object({ number: z.number(), episodes: z.array(z.object({ number: z.number() })) }))
    .default([]),
});
const WatchedMovie = z.object({ last_watched_at: z.string().nullish(), movie: Media });
const Rated = z.object({
  rating: z.number(),
  rated_at: z.string().nullish(),
  show: Media.optional(),
  movie: Media.optional(),
  season: z.object({ number: z.number() }).optional(),
});

function ids(m: z.infer<typeof Media>): SyncIds {
  const out: SyncIds = {};
  const tmdb = num(m.ids.tmdb);
  const tvdb = num(m.ids.tvdb);
  if (tmdb) out.tmdb = tmdb;
  if (tvdb) out.tvdb = tvdb;
  if (m.ids.imdb) out.imdb = m.ids.imdb;
  return out;
}

/** Turn what Trakt returned into list entries. Pure. */
export function traktEntries(dump: TraktListDump): ListEntry[] {
  const shows = new Map<number, Extract<ListEntry, { shape: "seasons" }>>();
  const movies = new Map<number, Extract<ListEntry, { shape: "movie" }>>();
  const show = (m: z.infer<typeof Media>) => {
    let e = shows.get(m.ids.trakt);
    if (!e) {
      e = {
        tracker: "trakt",
        shape: "seasons",
        id: m.ids.trakt,
        title: m.title ?? "",
        year: m.year ?? undefined,
        ids: ids(m),
        rating: null,
        seasons: {},
      };
      shows.set(m.ids.trakt, e);
    }
    return e;
  };
  const movie = (m: z.infer<typeof Media>) => {
    let e = movies.get(m.ids.trakt);
    if (!e) {
      e = {
        tracker: "trakt",
        shape: "movie",
        id: m.ids.trakt,
        title: m.title ?? "",
        year: m.year ?? undefined,
        ids: ids(m),
        rating: null,
        watched: false,
      };
      movies.set(m.ids.trakt, e);
    }
    return e;
  };

  for (const w of parseEach(WatchedShow, dump.shows)) {
    const e = show(w.show);
    const seasons: SeasonEpisodes = {};
    for (const s of w.seasons) seasons[s.number] = s.episodes.map((x) => x.number);
    e.seasons = seasons;
    e.updatedAt = ms(w.last_watched_at);
  }
  for (const w of parseEach(WatchedMovie, dump.movies)) {
    const e = movie(w.movie);
    e.watched = true;
    e.updatedAt = ms(w.last_watched_at);
  }
  for (const r of parseEach(Rated, dump.showRatings)) {
    if (!r.show) continue;
    const e = show(r.show);
    e.rating = r.rating * 10;
    e.updatedAt = newest(e.updatedAt, ms(r.rated_at));
  }
  for (const r of parseEach(Rated, dump.seasonRatings)) {
    if (!r.show || !r.season) continue;
    const e = show(r.show);
    e.seasonRatings = { ...e.seasonRatings, [r.season.number]: r.rating * 10 };
  }
  for (const r of parseEach(Rated, dump.movieRatings)) {
    if (!r.movie) continue;
    const e = movie(r.movie);
    e.rating = r.rating * 10;
    e.updatedAt = newest(e.updatedAt, ms(r.rated_at));
  }
  return [...shows.values(), ...movies.values()];
}

/** Read only what the chosen kinds need (anime can be a show or a movie). */
export async function readTraktEntries(kinds: SyncKind[]): Promise<ListEntry[]> {
  const anime = kinds.includes("anime");
  return traktEntries(
    await readTraktList({
      shows: anime || kinds.includes("tv"),
      movies: anime || kinds.includes("movie"),
    }),
  );
}
