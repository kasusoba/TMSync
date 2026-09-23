import type { ParsedMedia } from "@tmsync/shared";
import { resolveById as anilistResolveById } from "../anilist/client";
import { malResolutionCache } from "../storage";
import type { CourEntry, CourStatus } from "../tracker/cour-plan";
import { getValidAccessToken, refreshAfterReject } from "./auth";
import { MAL } from "./config";
import type { MalAnimeNode, MalIdentity, MalListStatus } from "./types";

export class MalNotConnectedError extends Error {
  constructor() {
    super("Not connected to MyAnimeList");
    this.name = "MalNotConnectedError";
  }
}

/**
 * MAL answered 403, its "DoS detected" guard. Community reports say bursts earn a
 * temporary IP ban, so callers surface this and never retry in a loop.
 */
export class MalRateLimitError extends Error {
  constructor() {
    super("MyAnimeList is limiting requests, try again later");
    this.name = "MalRateLimitError";
  }
}

type FormValue = string | number | boolean;

/**
 * Call the MAL REST API. With a token it sends the bearer; without one, a public
 * read sends `X-MAL-CLIENT-ID` (search and details work logged out). `auth` makes
 * the token required. A 401 refreshes the token once and retries. Returns null on
 * 404 (no such anime).
 */
async function malFetch<T>(
  path: string,
  opts: { method?: "GET" | "PATCH"; form?: Record<string, FormValue>; auth?: boolean } = {},
): Promise<T | null> {
  let token = await getValidAccessToken();
  if (opts.auth && !token) throw new MalNotConnectedError();
  if (!token && !MAL.clientId) throw new MalNotConnectedError();

  const send = (bearer: string | null) =>
    fetch(`${MAL.apiBase}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : { "X-MAL-CLIENT-ID": MAL.clientId }),
        ...(opts.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: opts.form
        ? new URLSearchParams(
            Object.entries(opts.form).map(([k, v]) => [k, String(v)] as [string, string]),
          )
        : undefined,
    });

  let res = await send(token);
  if (res.status === 401 && token) {
    token = await refreshAfterReject();
    if (!token) {
      if (opts.auth) throw new MalNotConnectedError();
      res = await send(null); // a public read can still go through logged out
    } else {
      res = await send(token);
    }
  }
  if (res.status === 403) throw new MalRateLimitError();
  if (res.status === 404) return null;
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 160);
    } catch {
      // ignore unreadable body
    }
    throw new Error(`MyAnimeList ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

const NODE_FIELDS = "id,title,alternative_titles,start_date,media_type,num_episodes";

/** Cache key for a MAL resolution: a native id when present, else title (+year). */
export function malCacheKey(media: ParsedMedia): string {
  if (media.ids?.mal !== undefined) return `id:${media.ids.mal}`;
  if (media.ids?.anilist !== undefined) return `al:${media.ids.anilist}`;
  return `${media.title.trim().toLowerCase()}:${media.year ?? ""}`;
}

/** Map an anime node to our identity. English title first (as AniList does), else
 * MAL's main (romaji) title. MAL reports 0 episodes for unknown/ongoing. Pure. */
export function nodeToIdentity(node: MalAnimeNode): MalIdentity {
  const year = Number(node.start_date?.slice(0, 4));
  return {
    id: node.id,
    title: node.alternative_titles?.en || node.title || `MAL #${node.id}`,
    year: Number.isFinite(year) && year > 0 ? year : undefined,
    episodes: node.num_episodes ? node.num_episodes : null,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Pick the best search hit for a scraped title. Movies are skipped: anime movies
 * route to Trakt, and cour trackers record series (as AniList's search does). An
 * exact title match (main, English, or synonym) wins, preferring the scraped year;
 * else the first hit from the scraped year; else MAL's top hit. Pure.
 */
export function pickBest(
  nodes: MalAnimeNode[],
  title: string,
  year?: number,
): MalAnimeNode | undefined {
  const series = nodes.filter((n) => n.media_type !== "movie");
  const want = norm(title);
  const yearOf = (n: MalAnimeNode) => Number(n.start_date?.slice(0, 4));
  const names = (n: MalAnimeNode) => [
    n.title,
    n.alternative_titles?.en ?? "",
    ...(n.alternative_titles?.synonyms ?? []),
  ];
  const exact = series.filter((n) => names(n).some((t) => t && norm(t) === want));
  if (year !== undefined) {
    const hit = exact.find((n) => yearOf(n) === year) ?? series.find((n) => yearOf(n) === year);
    if (hit) return hit;
  }
  return exact[0] ?? series[0];
}

/** One anime by MAL id (public read). Null when MAL has no such id. */
export async function getAnime(id: number): Promise<MalIdentity | null> {
  const node = await malFetch<MalAnimeNode>(`/anime/${id}?fields=${NODE_FIELDS}`);
  return node ? nodeToIdentity(node) : null;
}

/** Title search (public read). MAL's `limit` caps at 100; ten is plenty. */
async function searchAnime(title: string): Promise<MalAnimeNode[]> {
  const q = encodeURIComponent(title.trim().slice(0, 64));
  const data = await malFetch<{ data: { node: MalAnimeNode }[] }>(
    `/anime?q=${q}&limit=10&fields=${NODE_FIELDS}`,
  );
  return (data?.data ?? []).map((d) => d.node);
}

/**
 * Resolve scraped media → a MAL series identity (cached). Native id first (exact),
 * then an AniList id through AniList's `idMal` (the entries are 1:1), then a title
 * search. A bad id falls through to the title, like the AniList resolver.
 */
export async function resolve(media: ParsedMedia): Promise<MalIdentity | null> {
  const key = malCacheKey(media);
  const cache = await malResolutionCache.getValue();
  const cached = cache[key];
  if (cached) return cached;

  let identity: MalIdentity | null = null;
  try {
    if (media.ids?.mal !== undefined) {
      identity = await getAnime(Number(media.ids.mal));
    } else if (media.ids?.anilist !== undefined) {
      identity = await resolveViaAniList(Number(media.ids.anilist));
    }
  } catch (e) {
    if (e instanceof MalRateLimitError) throw e;
    identity = null; // bad id → degrade to a title match below
  }
  // MAL rejects very short queries; a title that short can't be matched well anyway.
  if (!identity && media.title && media.title.trim().length >= 3) {
    const best = pickBest(await searchAnime(media.title), media.title, media.year);
    identity = best ? nodeToIdentity(best) : null;
  }
  if (!identity) return null;
  await malResolutionCache.setValue({ ...cache, [key]: identity });
  return identity;
}

/** The MAL entry for a known AniList id, via AniList's `idMal`. */
export async function resolveViaAniList(anilistId: number): Promise<MalIdentity | null> {
  const al = await anilistResolveById(anilistId);
  return al?.idMal !== undefined ? getAnime(al.idMal) : null;
}

/** MAL's status in the cour planner's words. Rewatching is a completed entry with
 * `is_rewatching` set. Pure. */
export function toCourEntry(s: MalListStatus): CourEntry {
  const status: Record<NonNullable<MalListStatus["status"]>, CourStatus> = {
    watching: "CURRENT",
    completed: s.is_rewatching ? "REPEATING" : "COMPLETED",
    on_hold: "PAUSED",
    dropped: "DROPPED",
    plan_to_watch: "PLANNING",
  };
  return {
    status: s.status ? status[s.status] : null,
    progress: s.num_episodes_watched ?? 0,
    repeat: s.num_times_rewatched ?? 0,
  };
}

const LIST_FIELDS =
  "my_list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched,comments}";

/**
 * The viewer's raw list status for an anime (status, progress, score, note).
 * Requires auth. Null only when the anime is not on their list. A failed read
 * throws: planning it as "not on the list" could overwrite a completed entry.
 */
export async function getMyListStatus(id: number): Promise<MalListStatus | null> {
  const node = await malFetch<MalAnimeNode>(`/anime/${id}?fields=${LIST_FIELDS}`, { auth: true });
  if (!node) throw new Error(`MyAnimeList has no anime ${id}`);
  return node.my_list_status ?? null;
}

/** The viewer's list entry for an anime: the source of truth for the planner. */
export async function getListEntry(id: number): Promise<CourEntry | null> {
  const status = await getMyListStatus(id);
  return status ? toCourEntry(status) : null;
}

/** Fields one list-status write can set. MAL updates only the ones sent. */
export interface MalListFields {
  status?: MalListStatus["status"];
  is_rewatching?: boolean;
  num_watched_episodes?: number;
  num_times_rewatched?: number;
  /** 0 clears the score. */
  score?: number;
  /** The private note. "" clears it. */
  comments?: string;
}

/** Write list-status fields (creates the entry if absent). Requires auth. */
export async function updateListStatus(
  id: number,
  fields: MalListFields,
): Promise<{ ok: boolean; error?: string }> {
  const form: Record<string, FormValue> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form[k] = v;
  try {
    await malFetch(`/anime/${id}/my_list_status`, { method: "PATCH", form, auth: true });
    return { ok: true };
  } catch (e) {
    if (e instanceof MalNotConnectedError) throw e;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
