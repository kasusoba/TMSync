import { wetrakrCorrections, wetrakrIdsCache, wetrakrResolutionCache } from "@/lib/storage";
import { type ParsedMedia, primaryId } from "@tmsync/shared";
import { hasTrackerAccess } from "../access";
import { errorDetail } from "../oauth";
import { baseHeaders, getValidAccessToken, refreshAfterReject } from "./auth";
import { WETRAKR } from "./config";
import type {
  ScrobbleAction,
  ScrobbleBody,
  ScrobbleReply,
  WetrakrIdentity,
  WetrakrIds,
  WetrakrMedia,
} from "./types";

export class WetrakrNotConnectedError extends Error {
  constructor() {
    super("Not connected to WeTrakr");
    this.name = "WetrakrNotConnectedError";
  }
}

interface ApiInit {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
}

/**
 * Fetch a WeTrakr API path with the standard headers. Attaches the bearer token when
 * connected; on a 401 it refreshes once and retries. Every call needs the host grant
 * (no CORS headers). `requireAuth` throws when there is no token.
 */
async function api(path: string, init: ApiInit = {}, requireAuth = false): Promise<Response> {
  if (!(await hasTrackerAccess("wetrakr"))) throw new WetrakrNotConnectedError();
  let token = await getValidAccessToken();
  if (requireAuth && !token) throw new WetrakrNotConnectedError();

  const send = (t: string | null) =>
    fetch(`${WETRAKR.apiBase}${path}`, {
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: t ? { ...baseHeaders(), Authorization: `Bearer ${t}` } : baseHeaders(),
    });

  let res = await send(token);
  if (res.status === 401 && token) {
    token = await refreshAfterReject(token);
    if (token) res = await send(token);
  }
  return res;
}

/** Cache key for a resolution: identity is independent of season and episode. An id
 * is the strongest key, so an id-resolved item never collides with a title. Pure. */
export function wetrakrCacheKey(media: ParsedMedia): string {
  const mediaType =
    media.season !== undefined || media.episode !== undefined ? "show" : media.mediaType;
  const id = primaryId(media);
  if (id) return `${mediaType}:${id.namespace}:${id.value}`;
  return `${mediaType}:${media.title.trim().toLowerCase()}:${media.year ?? ""}`;
}

/** The year of an ISO date, or undefined. Pure. */
export function yearOf(date: string | undefined): number | undefined {
  const y = date ? Number(date.slice(0, 4)) : Number.NaN;
  return Number.isFinite(y) && y > 0 ? y : undefined;
}

/** A title from a detail or search object. Pure. */
export function toIdentity(m: WetrakrMedia): WetrakrIdentity {
  return {
    mediaType: m.type,
    id: m.id,
    title: m.title,
    year: yearOf(m.type === "movie" ? m.release_date : (m.first_air_date ?? m.release_date)),
  };
}

const plural = (type: "movie" | "show") => (type === "movie" ? "movies" : "shows");

/** GET /movies/{id} or /shows/{id}, caching the external ids it carries. */
async function details(type: "movie" | "show", id: number): Promise<WetrakrMedia | null> {
  const res = await api(`/${plural(type)}/${id}`);
  if (!res.ok) return null;
  const media = (await res.json()) as WetrakrMedia;
  if (media.ids) {
    const cache = await wetrakrIdsCache.getValue();
    await wetrakrIdsCache.setValue({ ...cache, [`${type}:${id}`]: media.ids });
  }
  return { ...media, type };
}

/** External ids of a title (cached). Empty when unknown. */
async function idsFor(type: "movie" | "show", id: number): Promise<WetrakrIds> {
  const hit = (await wetrakrIdsCache.getValue())[`${type}:${id}`];
  if (hit) return hit;
  return (await details(type, id))?.ids ?? {};
}

/**
 * Resolve scraped media to a WeTrakr title (cached). A user fix wins. A page id
 * (tmdb, then imdb, then tvdb) is looked up exactly, with no title fallback, so a
 * same-title remake cannot be picked. Otherwise a title search, where a movie's
 * year picks among the hits. Null when nothing matches.
 */
export async function resolve(media: ParsedMedia): Promise<WetrakrIdentity | null> {
  const key = wetrakrCacheKey(media);
  const fixed = (await wetrakrCorrections.getValue())[key];
  if (fixed) return fixed;
  const cache = await wetrakrResolutionCache.getValue();
  if (cache[key]) return cache[key];

  // extract() settled movie or show; trust it (a TMDB id means different titles in
  // the movie and tv namespaces).
  const type = media.mediaType;
  let identity: WetrakrIdentity | null = null;
  const ref =
    media.ids?.tmdb !== undefined
      ? `tmdb/${media.ids.tmdb}`
      : media.ids?.imdb !== undefined
        ? `imdb/${media.ids.imdb}`
        : media.ids?.tvdb !== undefined
          ? `tvdb/${media.ids.tvdb}`
          : null;
  if (ref) {
    const res = await api(`/media/external/${ref}?type=${type}`);
    if (!res.ok) return null;
    const hit = (await res.json()) as { id: number; type: "movie" | "show" };
    const full = await details(hit.type, hit.id);
    if (!full) return null;
    identity = toIdentity(full);
  } else {
    const hits = await searchMedia(media.title, type, 10);
    const best =
      (type === "movie" && media.year !== undefined
        ? hits.find((h) => toIdentity(h).year === media.year)
        : undefined) ?? hits[0];
    if (!best) return null;
    identity = toIdentity(best);
  }
  await wetrakrResolutionCache.setValue({ ...cache, [key]: identity });
  return identity;
}

/** GET /search for one type. */
async function searchMedia(
  query: string,
  type: "movie" | "show",
  limit: number,
): Promise<WetrakrMedia[]> {
  if (!query.trim()) return [];
  const q = new URLSearchParams({ q: query, filter_type: type, limit: String(limit) });
  const res = await api(`/search?${q}`);
  if (!res.ok) return [];
  const hits = (await res.json()) as WetrakrMedia[];
  return hits.filter((h) => h.type === type);
}

/** A search result with the external ids the pick is known by. */
export interface WetrakrSearchOption extends WetrakrIdentity {
  ids: WetrakrIds;
}

/**
 * Free-text search for the fix-match and manual pickers. Search results carry no
 * external ids, so each hit's ids come from its (cached) detail call: a pick then
 * reaches the other trackers by id. Few hits, to keep the calls few.
 */
export async function search(
  query: string,
  type: "movie" | "show",
): Promise<WetrakrSearchOption[]> {
  const hits = await searchMedia(query, type, 8);
  return Promise.all(
    hits.map(async (h) => ({ ...toIdentity(h), ids: await idsFor(h.type, h.id) })),
  );
}

/** Pin the scraped media to the title the user picked. The fix wins in `resolve`,
 * and dropping the cached resolution makes it take effect now. */
export async function saveCorrection(media: ParsedMedia, identity: WetrakrIdentity): Promise<void> {
  const key = wetrakrCacheKey(media);
  await wetrakrCorrections.setValue({ ...(await wetrakrCorrections.getValue()), [key]: identity });
  const cache = await wetrakrResolutionCache.getValue();
  if (cache[key]) {
    delete cache[key];
    await wetrakrResolutionCache.setValue(cache);
  }
}

export interface ScrobbleOutcome {
  ok: boolean;
  status: number;
  reply?: ScrobbleReply;
  error?: string;
}

/** POST /scrobble/{action}. A 404 means WeTrakr has no such title or episode. */
export async function scrobble(
  action: ScrobbleAction,
  body: ScrobbleBody,
): Promise<ScrobbleOutcome> {
  const res = await api(`/scrobble/${action}`, { method: "POST", body }, true);
  if (res.status === 404) return { ok: false, status: 404, error: "Not found on WeTrakr" };
  if (!res.ok)
    return { ok: false, status: res.status, error: (await errorDetail(res)) || undefined };
  return { ok: true, status: res.status, reply: (await res.json()) as ScrobbleReply };
}

/** DELETE /scrobble/playing: drop this title's session without logging a play. */
export async function cancelPlaying(body: ScrobbleBody): Promise<void> {
  const { progress: _p, app_version: _v, ...target } = body;
  await api("/scrobble/playing", { method: "DELETE", body: target }, true);
}

// --- ratings, comments, and watched progress ---

export type ReviewLevel = "movie" | "show" | "season" | "episode";

/** The API path of the movie, show, season, or episode a level names. Null when a
 * season or episode level lacks its number. Pure. */
export function itemPath(
  identity: WetrakrIdentity,
  level: ReviewLevel,
  season?: number,
  episode?: number,
): string | null {
  if (level === "movie") return `/movies/${identity.id}`;
  const show = `/shows/${identity.id}`;
  if (level === "show") return show;
  if (season === undefined) return null;
  if (level === "season") return `${show}/seasons/${season}`;
  if (episode === undefined) return null;
  return `${show}/seasons/${season}/episodes/${episode}`;
}

/** Body for POST /sync/ratings and /sync/ratings/remove (which ignores `rating`).
 * A season or episode nests by number under the show's WeTrakr id. Pure. */
export function ratingBody(
  identity: WetrakrIdentity,
  level: ReviewLevel,
  season: number | undefined,
  episode: number | undefined,
  rating?: number,
): Record<string, unknown> | null {
  const r = rating !== undefined ? { rating } : {};
  const id = { id: identity.id };
  if (level === "movie") return { movies: [{ ...id, ...r }] };
  if (level === "show") return { shows: [{ ...id, ...r }] };
  if (season === undefined) return null;
  if (level === "season") return { shows: [{ ...id, seasons: [{ number: season, ...r }] }] };
  if (episode === undefined) return null;
  return {
    shows: [{ ...id, seasons: [{ number: season, episodes: [{ number: episode, ...r }] }] }],
  };
}

interface Interactions {
  interactions?: {
    user?: {
      rating?: { rating: number };
      tracking?: { last?: { status?: string; last_watched_at?: string } };
    };
  };
}

/** GET an item with the user's interactions. Null when it is not on WeTrakr. */
async function getItem<T>(path: string): Promise<(T & Interactions) | null> {
  const res = await api(`${path}${path.includes("?") ? "&" : "?"}extended=interactions`, {}, true);
  if (!res.ok) return null;
  return (await res.json()) as T & Interactions;
}

/** The user's rating of an item on WeTrakr (0 to 10), or null. */
export async function getRemoteRating(path: string): Promise<number | null> {
  return (await getItem<object>(path))?.interactions?.user?.rating?.rating ?? null;
}

/** The WeTrakr id of the item at a path (a comment on a season or episode needs it). */
export async function itemId(path: string): Promise<number | null> {
  const res = await api(path);
  if (!res.ok) return null;
  return ((await res.json()) as { id?: number }).id ?? null;
}

export interface WriteOutcome {
  ok: boolean;
  error?: string;
}

/** A failed write's message: WeTrakr's own text when it gave one. */
async function failure(res: Response): Promise<WriteOutcome> {
  return { ok: false, error: (await errorDetail(res)) || `failed (${res.status})` };
}

/** POST /sync/ratings, or /sync/ratings/remove. */
export async function syncRatings(
  body: Record<string, unknown>,
  remove = false,
): Promise<WriteOutcome> {
  const res = await api(`/sync/ratings${remove ? "/remove" : ""}`, { method: "POST", body }, true);
  return res.ok ? { ok: true } : failure(res);
}

/** POST /sync/comments on one item. Returns the new comment's id. */
export async function postComment(
  target:
    | { movie: { id: number } }
    | { show: { id: number } }
    | { season: { id: number } }
    | { episode: { id: number } },
  text: string,
  spoiler: boolean,
): Promise<WriteOutcome & { id?: number }> {
  const res = await api(
    "/sync/comments",
    { method: "POST", body: { ...target, text, spoiler } },
    true,
  );
  if (!res.ok) return failure(res);
  return { ok: true, id: ((await res.json()) as { id?: number }).id };
}

/** DELETE /sync/comments/{id}. A comment already gone counts as deleted. */
export async function deleteComment(id: number): Promise<WriteOutcome> {
  const res = await api(`/sync/comments/${id}`, { method: "DELETE" }, true);
  return res.ok || res.status === 404 ? { ok: true } : failure(res);
}

/** One season's episodes with the user's tracking state. */
export interface WetrakrEpisode extends Interactions {
  number: number;
  air_date?: string | null;
}

/** The season numbers of a show (specials, season 0, left out). */
export async function seasonNumbers(showId: number): Promise<number[] | null> {
  const res = await api(`/shows/${showId}/seasons`, {}, true);
  if (!res.ok) return null;
  const seasons = (await res.json()) as { number: number }[];
  return seasons.map((x) => x.number).filter((n) => n > 0);
}

/** A season's episodes with the user's tracking state. */
export async function seasonEpisodes(showId: number, season: number): Promise<WetrakrEpisode[]> {
  const res = await api(`/shows/${showId}/seasons/${season}/episodes`, {}, true);
  return res.ok ? ((await res.json()) as WetrakrEpisode[]) : [];
}

// --- list sync (docs/ARCHITECTURE.md section 7) ---

/** Every page of a paged list (100 per page, `X-Pagination-Page-Count`). */
async function allPages(path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await api(`${path}${sep}limit=100&page=${page}`, {}, true);
    if (!res.ok) throw new Error(`WeTrakr ${path} returned ${res.status}`);
    const rows = (await res.json()) as unknown[];
    out.push(...rows);
    const count = Number(res.headers.get("X-Pagination-Page-Count") ?? "1");
    if (!rows.length || page >= count) return out;
  }
}

/** Every row of a compact list (up to 5,000 per call, cursor in `X-Pagination-Next`). */
async function allCompact(path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let after: string | null = null;
  for (;;) {
    const q = new URLSearchParams({ compact: "true", limit: "5000" });
    if (after) q.set("after", after);
    const res = await api(`${path}?${q}`, {}, true);
    if (!res.ok) throw new Error(`WeTrakr ${path} returned ${res.status}`);
    out.push(...((await res.json()) as unknown[]));
    after = res.headers.get("X-Pagination-Next");
    if (!after) return out;
  }
}

/** Everything list sync reads from WeTrakr, as WeTrakr returns it. */
export interface WetrakrListDump {
  /** Show entries of every tracking list that holds watches (titles, ids). */
  shows: unknown[];
  /** Every episode play, compact. */
  episodePlays: unknown[];
  /** Watched movies. */
  movies: unknown[];
  showRatings: unknown[];
  seasonRatings: unknown[];
  movieRatings: unknown[];
}

/** The tracking lists a show with watched episodes can sit in. */
const SHOW_LISTS = ["watching", "waiting", "watched", "paused", "dropped"] as const;

/** Read the user's watches and ratings: the parts not wanted are skipped. */
export async function readWetrakrList(want: {
  shows: boolean;
  movies: boolean;
}): Promise<WetrakrListDump> {
  const none = Promise.resolve<unknown[]>([]);
  const [shows, episodePlays, movies, showRatings, seasonRatings, movieRatings] = await Promise.all(
    [
      want.shows
        ? Promise.all(SHOW_LISTS.map((s) => allPages(`/sync/tracking/${s}/shows`))).then((l) =>
            l.flat(),
          )
        : none,
      want.shows ? allCompact("/sync/tracking/watched/history/episodes") : none,
      want.movies ? allPages("/sync/tracking/watched/movies") : none,
      want.shows ? allPages("/sync/ratings/shows") : none,
      want.shows ? allPages("/sync/ratings/seasons") : none,
      want.movies ? allPages("/sync/ratings/movies") : none,
    ],
  );
  return { shows, episodePlays, movies, showRatings, seasonRatings, movieRatings };
}

/** WeTrakr's change stamps (`/sync/last_activities`), unparsed. */
export async function readWetrakrActivity(): Promise<unknown> {
  const res = await api("/sync/last_activities", {}, true);
  if (!res.ok) throw new Error(`WeTrakr /sync/last_activities returned ${res.status}`);
  return res.json();
}

/** A WeTrakr sync POST: status, the JSON body when it worked, and a short error. */
export async function syncPost(
  path: "/sync/tracking" | "/sync/ratings" | "/sync/ratings/remove",
  body: unknown,
): Promise<{ status: number; data?: unknown; error?: string }> {
  const res = await api(path, { method: "POST", body }, true);
  if (!res.ok) return { status: res.status, error: await errorDetail(res) };
  return { status: res.status, data: await res.json().catch(() => undefined) };
}

/** A WeTrakr title and its external ids by WeTrakr id (the wetrakr.com quick links). */
export async function pageMedia(
  type: "movie" | "show",
  id: number,
): Promise<{ title: string; tmdb?: number; imdb?: string } | null> {
  const m = await details(type, id);
  if (!m) return null;
  const tmdb = Number(m.ids?.tmdb);
  return {
    title: m.title,
    tmdb: Number.isFinite(tmdb) && tmdb > 0 ? tmdb : undefined,
    imdb: m.ids?.imdb,
  };
}
