import { TRAKT } from "@/config";
import { corrections, remoteRatings, resolutionCache } from "@/lib/storage";
import type { ParsedMedia } from "@tmsync/shared";
import { getValidAccessToken, refreshTokens } from "./auth";
import {
  type LetterboxdComment,
  type TraktHistoryMovie,
  type TraktRatedMovie,
  buildLetterboxdRows,
  toLetterboxdCsv,
} from "./letterboxd";
import type {
  RatingSyncBody,
  ResolvedIdentity,
  ReviewLevel,
  ScrobbleAction,
  ScrobbleBody,
  ScrobbleResponse,
  TraktSearchOption,
  TraktSearchResult,
} from "./types";
import { resolutionCacheKey, reviewKey } from "./util";

export class TraktNotConnectedError extends Error {
  constructor() {
    super("Not connected to Trakt");
    this.name = "TraktNotConnectedError";
  }
}

function baseHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": TRAKT.apiVersion,
    "trakt-api-key": TRAKT.clientId,
    "User-Agent": TRAKT.userAgent,
  };
}

interface ApiInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: string;
}

/**
 * Fetch a Trakt API path with the standard headers. Attaches the bearer token
 * when connected; on a 401 it refreshes once and retries. `requireAuth` throws
 * when there's no token (used by scrobble, which is meaningless unauthenticated).
 */
async function api(path: string, init: ApiInit = {}, requireAuth = false): Promise<Response> {
  let token = await getValidAccessToken();
  if (requireAuth && !token) throw new TraktNotConnectedError();

  const send = (t: string | null) =>
    fetch(`${TRAKT.apiBase}${path}`, {
      method: init.method ?? "GET",
      body: init.body,
      headers: t ? { ...baseHeaders(), Authorization: `Bearer ${t}` } : baseHeaders(),
    });

  let res = await send(token);
  if (res.status === 401 && token) {
    token = (await refreshTokens())?.access_token ?? null;
    if (token) res = await send(token);
  }
  return res;
}

/**
 * Resolve scraped media to a Trakt identity (cached). For shows we resolve the
 * show only; season/episode are attached at scrobble time. `years` disambiguates
 * movies. Returns null if nothing matches.
 */
export async function resolve(media: ParsedMedia): Promise<ResolvedIdentity | null> {
  const key = resolutionCacheKey(media);

  // A user correction is authoritative — never overridden by search.
  const correction = (await corrections.getValue())[key];
  if (correction) return correction;

  const cache = await resolutionCache.getValue();
  const cached = cache[key];
  if (cached) return cached;

  // extract() already settled movie-vs-show: an explicit recipe `mediaType`
  // wins; only "auto" falls back to season/episode presence. Trust it. Re-
  // deriving from season/episode here would push an explicit `movie` recipe
  // that scraped a stray number into TMDB's *tv* id namespace — e.g. tmdb id
  // 4977 is the film Paprika as a movie but a 1979 series as a show.
  const type: "movie" | "show" = media.mediaType;

  // Prefer an exact id lookup when the page gave us one (tmdb → imdb → tvdb, the
  // order Trakt resolves) — no title search, so same-title remakes / id-namespaced
  // shows can't be confused. `type` disambiguates (a namespace's movie and tv ids
  // are separate). Anything else (anilist/mal only) falls through to a title search.
  let res: Response;
  const idLookup =
    media.ids?.tmdb !== undefined
      ? `/search/tmdb/${media.ids.tmdb}?type=${type}`
      : media.ids?.imdb !== undefined
        ? `/search/imdb/${media.ids.imdb}?type=${type}`
        : media.ids?.tvdb !== undefined
          ? `/search/tvdb/${media.ids.tvdb}?type=${type}`
          : undefined;
  if (idLookup !== undefined) {
    res = await api(idLookup);
  } else {
    const query = new URLSearchParams({ query: media.title });
    // Year filters results, so only use it for movies — a scraped show "year"
    // is often the wrong (non-first-aired) year and would filter out the match.
    if (type === "movie" && media.year !== undefined) query.set("years", String(media.year));
    res = await api(`/search/${type}?${query.toString()}`);
  }
  if (!res.ok) return null;

  const results = (await res.json()) as TraktSearchResult[];
  const hit = results.find((r) => r.type === type);
  const obj = type === "movie" ? hit?.movie : hit?.show;
  if (!obj) return null;

  const identity: ResolvedIdentity = {
    mediaType: type,
    traktId: obj.ids.trakt,
    title: obj.title,
    year: obj.year,
  };
  await resolutionCache.setValue({ ...cache, [key]: identity });
  return identity;
}

/** Free-text Trakt search for the correction picker. */
export async function search(query: string, type?: "movie" | "show"): Promise<TraktSearchOption[]> {
  if (!query.trim()) return [];
  const res = await api(`/search/${type ?? "movie,show"}?query=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const results = (await res.json()) as TraktSearchResult[];
  const options: TraktSearchOption[] = [];
  for (const r of results) {
    const obj = r.type === "movie" ? r.movie : r.type === "show" ? r.show : undefined;
    if (obj && (r.type === "movie" || r.type === "show")) {
      options.push({ type: r.type, traktId: obj.ids.trakt, title: obj.title, year: obj.year });
    }
  }
  return options;
}

export interface ScrobbleOutcome {
  ok: boolean;
  status: number;
  /** Trakt's echoed action; "scrobble" means it was added to history. */
  action?: ScrobbleResponse["action"];
  /** Trakt's error body on failure (truncated) — surfaced for diagnosis. */
  error?: string;
}

/** POST /scrobble/{action}. A 409 ("already scrobbling") is treated as a no-op success. */
export async function scrobble(
  action: ScrobbleAction,
  body: ScrobbleBody,
): Promise<ScrobbleOutcome> {
  const res = await api(
    `/scrobble/${action}`,
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
  if (res.status === 409) return { ok: true, status: 409 };
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 120);
    } catch {
      // ignore unreadable body
    }
    // A pause under Trakt's 1% floor ("progress should be at least 1.0% to
    // pause") is benign — a pause only saves a resume position, and there's
    // nothing to save that early. Swallow it as a no-op like a 409 rather than
    // alarming the user; the adapter's guard normally skips it, this catches the
    // rounding boundary that slips past.
    if (action === "pause" && res.status === 422) return { ok: true, status: 422 };
    return { ok: false, status: res.status, error: detail || undefined };
  }
  const data = (await res.json()) as ScrobbleResponse;
  return { ok: true, status: res.status, action: data.action };
}

// --- watched progress (read; drives the popup "last watched / next up" line) ---

interface TraktProgressEpisode {
  number: number;
  completed: boolean;
  last_watched_at: string | null;
}
interface TraktProgressSeason {
  number: number;
  episodes: TraktProgressEpisode[];
}
export interface TraktWatchedProgress {
  /** Episodes aired so far. */
  aired: number;
  /** Episodes the user has watched. */
  completed: number;
  seasons: TraktProgressSeason[];
  /** Next episode to watch (first uncompleted aired one), or null if caught up. */
  next_episode: { season: number; number: number } | null;
}

/**
 * GET /shows/:id/progress/watched — the viewer's per-episode watched set plus the
 * next-to-watch pointer. Specials (season 0) are excluded by default. Auth
 * required; returns null on any non-2xx (e.g. not connected handled by caller).
 */
export async function watchedProgress(showId: number): Promise<TraktWatchedProgress | null> {
  const res = await api(`/shows/${showId}/progress/watched`, {}, true);
  if (!res.ok) return null;
  return (await res.json()) as TraktWatchedProgress;
}

// --- ratings (1–10) ---

/** POST /sync/ratings (set) or /sync/ratings/remove. Returns ok + status. */
export async function rate(
  body: RatingSyncBody,
  remove = false,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const res = await api(
    `/sync/ratings${remove ? "/remove" : ""}`,
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 120);
    } catch {
      // ignore unreadable body
    }
    return { ok: false, status: res.status, error: detail || undefined };
  }
  return { ok: true, status: res.status };
}

const RATING_TYPE: Record<ReviewLevel, string> = {
  movie: "movies",
  show: "shows",
  season: "seasons",
  episode: "episodes",
};
const REMOTE_TTL_MS = 5 * 60 * 1000;

/** reviewKey-shaped key for a /sync/ratings list item (matches util.reviewKey). */
function remoteItemKey(item: Record<string, unknown>, level: ReviewLevel): string | null {
  const id = (o: unknown): number | undefined =>
    (o as { ids?: { trakt?: number } } | undefined)?.ids?.trakt;
  if (level === "movie") {
    const t = id(item.movie);
    return t === undefined ? null : `movie:${t}::`;
  }
  const showT = id(item.show);
  if (showT === undefined) return null;
  if (level === "show") return `show:${showT}::`;
  if (level === "season") {
    const n = (item.season as { number?: number } | undefined)?.number;
    return n === undefined ? null : `season:${showT}:${n}:`;
  }
  const ep = item.episode as { season?: number; number?: number } | undefined;
  if (ep?.season === undefined || ep.number === undefined) return null;
  return `episode:${showT}:${ep.season}:${ep.number}`;
}

/**
 * The user's current Trakt rating for an item, so the UI reflects ratings set on
 * the website too. Fetches GET /sync/ratings/{type} (the whole list for that
 * type), distilled to a compact reviewKey→rating map cached on a TTL.
 */
export async function getRemoteRating(
  identity: ResolvedIdentity,
  level: ReviewLevel,
  season?: number,
  episode?: number,
): Promise<number | null> {
  const type = RATING_TYPE[level];
  const cache = await remoteRatings.getValue();
  let entry = cache[type];
  if (!entry || Date.now() - entry.at > REMOTE_TTL_MS) {
    const res = await api(`/sync/ratings/${type}`, {}, true);
    if (!res.ok) return null;
    const items = (await res.json()) as Record<string, unknown>[];
    const map: Record<string, number> = {};
    for (const it of items) {
      const k = remoteItemKey(it, level);
      if (k) map[k] = it.rating as number;
    }
    entry = { at: Date.now(), map };
    await remoteRatings.setValue({ ...cache, [type]: entry });
  }
  return entry.map[reviewKey(identity, level, season, episode)] ?? null;
}

// --- comments (managed as the user's single editable note per item) ---

/** Trakt comment object (only the fields we use). */
interface TraktComment {
  id: number;
  comment: string;
  spoiler: boolean;
}

/** The item a comment attaches to. Season/episode need their OWN trakt ids. */
type CommentItem =
  | { movie: { ids: { trakt: number } } }
  | { show: { ids: { trakt: number } } }
  | { season: { ids: { trakt: number } } }
  | { episode: { ids: { trakt: number } } };

/**
 * Resolve the item reference for a comment. Movie/show use the resolved id we
 * already have; season/episode need a lookup (Trakt comments require the item's
 * own trakt id, unlike ratings). Returns the item, or an error string describing
 * why the lookup failed (surfaced in the badge for diagnosis).
 */
export async function commentItem(
  identity: ResolvedIdentity,
  level: ReviewLevel,
  season?: number,
  episode?: number,
): Promise<{ item: CommentItem } | { error: string }> {
  if (level === "movie") return { item: { movie: { ids: { trakt: identity.traktId } } } };
  if (level === "show") return { item: { show: { ids: { trakt: identity.traktId } } } };
  if (season === undefined) return { error: "no season number scraped" };
  if (level === "season") {
    const res = await api(`/shows/${identity.traktId}/seasons`);
    if (!res.ok) return { error: `season lookup failed (${res.status})` };
    const seasons = (await res.json()) as { number: number; ids: { trakt: number } }[];
    const hit = seasons.find((s) => s.number === season);
    return hit
      ? { item: { season: { ids: { trakt: hit.ids.trakt } } } }
      : { error: `season ${season} not found on “${identity.title}”` };
  }
  if (episode === undefined) return { error: "no episode number scraped" };
  const res = await api(`/shows/${identity.traktId}/seasons/${season}/episodes/${episode}`);
  if (!res.ok) {
    return {
      error:
        res.status === 404
          ? `S${season}E${episode} not found on “${identity.title}” · wrong match?`
          : `episode lookup failed (${res.status})`,
    };
  }
  const ep = (await res.json()) as { ids?: { trakt?: number } };
  if (ep.ids?.trakt === undefined) return { error: "episode has no Trakt id" };
  return { item: { episode: { ids: { trakt: ep.ids.trakt } } } };
}

/** POST /comments — create a comment. Returns the new comment id. */
export async function postComment(
  item: CommentItem,
  comment: string,
  spoiler: boolean,
): Promise<{ ok: boolean; id?: number; error?: string }> {
  const res = await api(
    "/comments",
    { method: "POST", body: JSON.stringify({ ...item, comment, spoiler }) },
    true,
  );
  if (!res.ok) return { ok: false, error: await errorDetail(res) };
  const data = (await res.json()) as TraktComment;
  return { ok: true, id: data.id };
}

/** PUT /comments/{id} — edit an existing comment. */
export async function updateComment(
  id: number,
  comment: string,
  spoiler: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const res = await api(
    `/comments/${id}`,
    { method: "PUT", body: JSON.stringify({ comment, spoiler }) },
    true,
  );
  return res.ok ? { ok: true } : { ok: false, error: await errorDetail(res) };
}

/** DELETE /comments/{id}. A 404 means it's already gone — treat as success. */
export async function deleteComment(id: number): Promise<{ ok: boolean; error?: string }> {
  const res = await api(`/comments/${id}`, { method: "DELETE" }, true);
  if (res.ok || res.status === 404) return { ok: true };
  return { ok: false, error: await errorDetail(res) };
}

async function errorDetail(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).trim().slice(0, 160) || undefined;
  } catch {
    return undefined;
  }
}

// --- Letterboxd export (reads Trakt only; constraint #1) ---

/** Raw item from GET /users/me/comments/all/movies. */
interface RawMovieComment {
  type: string;
  comment?: { comment?: string; review?: boolean };
  movie?: { ids: { trakt: number } };
}

/** Walk a paginated Trakt list endpoint to completion (auth required). */
async function getAllPages<T>(path: string, limit = 100): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  let pageCount = 1;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const res = await api(`${path}${sep}page=${page}&limit=${limit}`, {}, true);
    if (!res.ok) throw new Error(`Trakt ${path} returned ${res.status}`);
    out.push(...((await res.json()) as T[]));
    pageCount = Number(res.headers.get("X-Pagination-Page-Count")) || 1;
    page += 1;
  } while (page <= pageCount);
  return out;
}

/**
 * Build a Letterboxd-import CSV from the user's Trakt movies. Reads *history*
 * (one record per play) so rewatches survive, plus ratings and comments. Pure
 * shaping lives in @tmsync/shared; here we just fetch + normalise.
 */
export async function exportLetterboxd(): Promise<{ csv: string; count: number }> {
  const [history, ratings, rawComments] = await Promise.all([
    getAllPages<TraktHistoryMovie>("/sync/history/movies"),
    getAllPages<TraktRatedMovie>("/sync/ratings/movies"),
    getAllPages<RawMovieComment>("/users/me/comments/all/movies"),
  ]);

  const comments: LetterboxdComment[] = [];
  for (const c of rawComments) {
    if (c.type === "movie" && c.movie && c.comment?.comment) {
      comments.push({
        movieId: c.movie.ids.trakt,
        comment: c.comment.comment,
        isReview: !!c.comment.review,
      });
    }
  }

  const rows = buildLetterboxdRows({ history, ratings, comments });
  return { csv: toLetterboxdCsv(rows), count: rows.length };
}
