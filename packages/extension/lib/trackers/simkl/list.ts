/**
 * Simkl's list for list sync. Simkl splits its library in three: `movies`,
 * `shows` (seasons and episodes, like Trakt), and `anime` (one entry per cour,
 * AniDB numbering, carrying mal and anilist ids). So shows read as `seasons`
 * entries and anime as `cour` entries.
 */
import { z } from "zod";
import { simklRatings } from "../../storage";
import {
  type ListCache,
  type ListRead,
  mergeById,
  newCache,
  readFrom,
  savedParts,
} from "../../sync/list-cache";
import { ms, newest, num, parseEach } from "../../sync/read-util";
import type { ListEntry, SyncIds, SyncKind } from "../../sync/types";
import type { CourStatus } from "../cour-plan";
import { type SimklListType, readSimklActivity, readSimklList } from "./client";

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
type SimklStatusValue = z.infer<typeof SimklStatus>;
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

/** A Simkl status in cour terms. Simkl has no rewatching status. */
export const SIMKL_TO_COUR: Record<SimklStatusValue, Exclude<CourStatus, "REPEATING">> = {
  watching: "CURRENT",
  plantowatch: "PLANNING",
  hold: "PAUSED",
  dropped: "DROPPED",
  completed: "COMPLETED",
};

/** A cour status in Simkl's words: `SIMKL_TO_COUR` the other way. A rewatch is a
 * completed entry. */
export const COUR_TO_SIMKL: Record<CourStatus, SimklStatusValue> = {
  ...(Object.fromEntries(
    Object.entries(SIMKL_TO_COUR).map(([simkl, cour]) => [cour, simkl]),
  ) as Record<Exclude<CourStatus, "REPEATING">, SimklStatusValue>),
  REPEATING: "completed",
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
    watchedAt: realTime(b.last_watched_at),
    status: b.status ? SIMKL_TO_COUR[b.status] : null,
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

/** Which Simkl type an entry was read from: shows read as `seasons`, anime as
 * `cour`, movies as `movie`. */
const simklPart = (e: ListEntry): SimklListType =>
  e.shape === "seasons" ? "shows" : e.shape === "cour" ? "anime" : "movies";

type SimklRead = "saved" | "empty" | "changes" | "full";

/** The `/sync/activities` key of each type. */
const ACTIVITY_KEY = { shows: "tv_shows", anime: "anime", movies: "movies" } as const;

const Stamp = z
  .object({ all: z.string().nullish(), removed_from_list: z.string().nullish() })
  .nullish();

/** Each type's stamps from `/sync/activities`: `all` moves on any change to that
 * type, `removed` only when an item leaves the library. Pure. */
export function simklStamps(
  raw: unknown,
): Partial<Record<SimklListType, { all?: string | null; removed?: string | null }>> {
  const r = z.object({ tv_shows: Stamp, anime: Stamp, movies: Stamp }).partial().safeParse(raw);
  if (!r.success) return {};
  const out: ReturnType<typeof simklStamps> = {};
  for (const type of ["shows", "anime", "movies"] as const) {
    const a = r.data[ACTIVITY_KEY[type]];
    if (a) out[type] = { all: a.all, removed: a.removed_from_list };
  }
  return out;
}

/** How to read each type, from the stamps now and the saved ones. Unmoved =
 * `saved`. A null stamp = the type never had any activity, so it is `empty` and
 * needs no read. Moved with nothing removed = `changes` (a `date_from`
 * delta, which never reports removals). Anything else = `full`. Pure. */
export function simklReadPlan(
  types: SimklListType[],
  now: ReturnType<typeof simklStamps>,
  saved: Record<string, string> | null,
): Record<SimklListType, SimklRead> {
  const out = {} as Record<SimklListType, SimklRead>;
  for (const type of types) {
    const all = now[type]?.all;
    const was = saved?.[type];
    if (now[type] && all === null) out[type] = "empty";
    else if (!all || !was) out[type] = "full";
    else if (all === was) out[type] = "saved";
    else
      out[type] =
        (now[type]?.removed ?? undefined) === saved?.[`${type}:removed`] ? "changes" : "full";
  }
  return out;
}

/**
 * Read only the Simkl types the chosen kinds need. Anime Simkl files under
 * `shows` is still read when TV or anime is on. `/sync/activities` comes first,
 * as Simkl asks: with a saved list, an unmoved type is not read at all, and a
 * moved one reads only its changes (see `sync/list-cache.ts`). On a timer (`timed`),
 * a failed check stops the read: Simkl suspends apps that poll without it.
 */
export async function readSimklEntries(
  kinds: SyncKind[],
  saved?: ListCache | null,
  timed = false,
): Promise<ListRead> {
  const types: SimklListType[] = [];
  if (kinds.includes("tv") || kinds.includes("anime")) types.push("shows");
  if (kinds.includes("anime")) types.push("anime");
  if (kinds.includes("movie")) types.push("movies");

  const now = await readSimklActivity().then(simklStamps, (e): ReturnType<typeof simklStamps> => {
    if (timed) throw e;
    return {};
  });
  if (timed && types.some((type) => !now[type])) {
    throw new Error("Simkl’s change check failed, so the automatic sync left Simkl out.");
  }
  const old = savedParts(saved, simklPart);
  const how = simklReadPlan(types, now, old && saved ? saved.stamps : null);
  const since: Partial<Record<SimklListType, string>> = {};
  for (const type of types) if (how[type] === "changes") since[type] = saved?.stamps[type];
  const toRead = types.filter((type) => how[type] === "changes" || how[type] === "full");
  const fresh = toRead.length ? simklEntries(await readSimklList(toRead, since)) : [];

  const entries = types.flatMap((type) => {
    const got = fresh.filter((e) => simklPart(e) === type);
    if (how[type] === "full") return got;
    if (how[type] === "empty") return [];
    const kept = old?.get(type) ?? [];
    return how[type] === "saved" ? kept : mergeById(kept, got);
  });
  await refreshMirror(fresh).catch(() => {});

  const stamps: Record<string, string | null | undefined> = {};
  for (const type of types) {
    stamps[type] = now[type]?.all;
    stamps[`${type}:removed`] = now[type]?.removed;
  }
  const count = (h: string) => types.filter((type) => how[type] === h).length;
  return {
    entries,
    cache: newCache(stamps, entries, Date.now()),
    from: readFrom({ saved: count("saved"), changes: count("changes"), full: count("full") }),
  };
}

/**
 * Bring the local rating mirror up to date: reading a rating back one at a time
 * costs quota, so the mirror is how the rating panel knows it, and a list read
 * has the ratings of every entry it returns. Keyed `simkl:<id>` (see simkl/review.ts).
 */
async function refreshMirror(entries: ListEntry[]): Promise<void> {
  const all = { ...(await simklRatings.getValue()) };
  for (const e of entries) {
    if (e.rating !== null) all[`simkl:${e.id}`] = Math.round(e.rating / 10);
    else delete all[`simkl:${e.id}`];
  }
  await simklRatings.setValue(all);
}
