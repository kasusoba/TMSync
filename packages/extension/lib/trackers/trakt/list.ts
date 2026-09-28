/**
 * Trakt's list for list sync: watched shows and movies, plus ratings, as
 * `ListEntry` values. Trakt keeps ratings apart from history, so an item that is
 * rated but not watched is still an entry (with nothing watched). Trakt has no
 * list status: completion is derived from episodes.
 */
import { z } from "zod";
import { type ListCache, type ListRead, newCache, readFrom, savedParts } from "../../sync/cache";
import { ms, newest, num, parseEach } from "../../sync/read";
import type { ListEntry, SeasonEpisodes, SyncIds, SyncKind } from "../../sync/types";
import { type TraktListDump, readTraktActivity, readTraktList } from "./client";

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

/** The parts of a Trakt list: shows (watched episodes, show and season ratings)
 * and movies (watched movies, movie ratings). */
type TraktPart = "shows" | "movies";

const traktPart = (e: ListEntry): TraktPart => (e.shape === "movie" ? "movies" : "shows");

/** Trakt's newest activity stamp, or null when it cannot be read. `all` moves on
 * any change to the account, so it may read when nothing in the list moved, but
 * it never misses a change (Trakt does not say which field a removal moves). */
export function traktStamp(raw: unknown): string | null {
  const r = z.object({ all: z.string() }).safeParse(raw);
  return r.success ? r.data.all : null;
}

/**
 * Read only what the chosen kinds need (anime can be a show or a movie). With a
 * saved list, ask Trakt's activity stamp first and reuse the parts it covers
 * when the stamp did not move (see `sync/cache.ts`).
 */
export async function readTraktEntries(
  kinds: SyncKind[],
  saved?: ListCache | null,
): Promise<ListRead> {
  const anime = kinds.includes("anime");
  const parts: TraktPart[] = [];
  if (anime || kinds.includes("tv")) parts.push("shows");
  if (anime || kinds.includes("movie")) parts.push("movies");

  // The stamp comes before the read, so a change made during the read moves it
  // past the saved one and the next read sees it.
  const stamp = await readTraktActivity().then(traktStamp, () => null);
  const old = savedParts(saved, traktPart);
  const reuse = parts.filter((p) => stamp && old && saved?.stamps[p] === stamp);
  const stale = parts.filter((p) => !reuse.includes(p));
  const fresh = stale.length
    ? traktEntries(
        await readTraktList({ shows: stale.includes("shows"), movies: stale.includes("movies") }),
      )
    : [];
  const entries = [...reuse.flatMap((p) => old?.get(p) ?? []), ...fresh];
  return {
    entries,
    cache: newCache(Object.fromEntries(parts.map((p) => [p, stamp])), entries, Date.now()),
    from: readFrom({ saved: reuse.length, changes: 0, full: stale.length }),
  };
}
