import type { ParsedMedia } from "@tmsync/shared";
import { anilistResolutionCache } from "../storage";
import { getValidAccessToken } from "./auth";
import { ANILIST } from "./config";
import type { AniListEntry, AniListIdentity, MediaListStatus, ScoreFormat } from "./types";

export class AniListNotConnectedError extends Error {
  constructor() {
    super("Not connected to AniList");
    this.name = "AniListNotConnectedError";
  }
}

/** Cache key for an AniList resolution: a native id when present, else title (+year). */
export function anilistCacheKey(media: ParsedMedia): string {
  if (media.ids?.anilist !== undefined) return `id:${media.ids.anilist}`;
  if (media.ids?.mal !== undefined) return `mal:${media.ids.mal}`;
  return `${media.title.trim().toLowerCase()}:${media.year ?? ""}`;
}

interface MediaNode {
  id: number;
  idMal?: number | null;
  episodes?: number | null;
  format?: string | null;
  startDate?: { year?: number | null } | null;
  title?: { romaji?: string | null; english?: string | null } | null;
}

/** A search result for the AniList correction picker (mirrors TraktSearchOption). */
export interface AniListSearchOption {
  id: number;
  title: string;
  year?: number;
  episodes: number | null;
  format?: string;
}

/** Pick a display title + map a `Media` node to our identity. Pure (unit-tested). */
export function mediaToIdentity(node: MediaNode): AniListIdentity {
  const title = node.title?.english || node.title?.romaji || `AniList #${node.id}`;
  return {
    id: node.id,
    title,
    year: node.startDate?.year ?? undefined,
    episodes: node.episodes ?? null,
    idMal: node.idMal ?? undefined,
  };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * POST a GraphQL query to AniList. `auth` attaches the bearer token (required for
 * writes + Viewer); reads (Media search) work unauthenticated, so the badge can
 * show the matched AniList title before the user connects.
 */
async function gql<T>(query: string, variables: Record<string, unknown>, auth = false): Promise<T> {
  const token = await getValidAccessToken();
  if (auth && !token) throw new AniListNotConnectedError();
  const res = await fetch(ANILIST.apiBase, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 160);
    } catch {
      // ignore unreadable body
    }
    throw new Error(`AniList ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new Error("AniList returned no data");
  return body.data;
}

const SEARCH_QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, format_not: MOVIE) {
    id idMal episodes
    startDate { year }
    title { romaji english }
  }
}`;

/**
 * Resolve scraped media → an AniList series identity (cached). `format_not: MOVIE`
 * keeps this to series — anime *movies* route to Trakt (constraint #2). Returns
 * null if nothing matches.
 */
export async function resolve(media: ParsedMedia): Promise<AniListIdentity | null> {
  const key = anilistCacheKey(media);
  const cache = await anilistResolutionCache.getValue();
  const cached = cache[key];
  if (cached) return cached;

  // Native id first (exact, no same-title ambiguity): an anilist id, else a MAL id.
  // Only fall back to a title search when the page exposed no AniList-native id.
  let node: MediaNode | null;
  if (media.ids?.anilist !== undefined) {
    node = (await gql<{ Media: MediaNode | null }>(BY_ID_QUERY, { id: Number(media.ids.anilist) }))
      .Media;
  } else if (media.ids?.mal !== undefined) {
    node = (await gql<{ Media: MediaNode | null }>(BY_MAL_QUERY, { idMal: Number(media.ids.mal) }))
      .Media;
  } else {
    node = (await gql<{ Media: MediaNode | null }>(SEARCH_QUERY, { search: media.title })).Media;
  }
  if (!node) return null;
  const identity = mediaToIdentity(node);
  await anilistResolutionCache.setValue({ ...cache, [key]: identity });
  return identity;
}

const BY_MAL_QUERY = `
query ($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
    id idMal episodes
    startDate { year }
    title { romaji english }
  }
}`;

const BY_ID_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id idMal episodes
    startDate { year }
    title { romaji english }
  }
}`;

/**
 * Resolve a KNOWN AniList Media id → identity (cached). The multi-track derived
 * path (docs/MULTI-TRACK.md) gets the id straight from the anime-map crosswalk, so
 * it resolves by id instead of a title search — exact, no same-title ambiguity.
 */
export async function resolveById(anilistId: number): Promise<AniListIdentity | null> {
  const key = `id:${anilistId}`;
  const cache = await anilistResolutionCache.getValue();
  const cached = cache[key];
  if (cached) return cached;

  const data = await gql<{ Media: MediaNode | null }>(BY_ID_QUERY, { id: anilistId });
  if (!data.Media) return null;
  const identity = mediaToIdentity(data.Media);
  await anilistResolutionCache.setValue({ ...cache, [key]: identity });
  return identity;
}

const SEARCH_LIST_QUERY = `
query ($search: String) {
  Page(perPage: 8) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id episodes format
      startDate { year }
      title { romaji english }
    }
  }
}`;

/** Free-text AniList search for the correction picker — top matches (reads work
 * unauthenticated). Returns [] for a blank query. */
export async function searchAniList(query: string): Promise<AniListSearchOption[]> {
  if (!query.trim()) return [];
  const data = await gql<{ Page: { media: MediaNode[] } | null }>(SEARCH_LIST_QUERY, {
    search: query,
  });
  return (data.Page?.media ?? []).map((n) => ({
    id: n.id,
    title: n.title?.english || n.title?.romaji || `AniList #${n.id}`,
    year: n.startDate?.year ?? undefined,
    episodes: n.episodes ?? null,
    format: n.format ?? undefined,
  }));
}

const LIST_ENTRY_QUERY = `
query ($mediaId: Int) {
  Media(id: $mediaId) { mediaListEntry { status progress repeat } }
}`;

/**
 * The viewer's current list entry for a Media — the source of truth for the
 * status state machine (CURRENT/COMPLETED/REPEATING, progress, repeat count).
 * Requires auth. Returns null if the user has no entry for it, or isn't connected.
 */
export async function getListEntry(mediaId: number): Promise<AniListEntry | null> {
  try {
    const data = await gql<{
      Media: { mediaListEntry: AniListEntry | null } | null;
    }>(LIST_ENTRY_QUERY, { mediaId }, true);
    const entry = data.Media?.mediaListEntry;
    if (!entry) return null;
    return {
      status: entry.status ?? null,
      progress: entry.progress ?? 0,
      repeat: entry.repeat ?? 0,
    };
  } catch (e) {
    if (e instanceof AniListNotConnectedError) throw e;
    return null;
  }
}

const SAVE_ENTRY_QUERY = `
mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus, $repeat: Int) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status, repeat: $repeat) {
    id progress status repeat
  }
}`;

/** Fields a single SaveMediaListEntry write can set (omitted ones are untouched). */
export interface SaveEntryFields {
  progress?: number;
  status?: MediaListStatus;
  repeat?: number;
}

/** Write an entry's progress/status/repeat in one mutation. Requires auth. */
export async function saveEntry(
  mediaId: number,
  fields: SaveEntryFields,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await gql(SAVE_ENTRY_QUERY, { mediaId, ...fields }, true);
    return { ok: true };
  } catch (e) {
    if (e instanceof AniListNotConnectedError) throw e;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const SCORE_FORMAT_QUERY = `
query { Viewer { mediaListOptions { scoreFormat } } }`;

/** The connected user's score format (for rendering the rating affordance). */
export async function viewerScoreFormat(): Promise<ScoreFormat | null> {
  try {
    const data = await gql<{ Viewer: { mediaListOptions?: { scoreFormat?: ScoreFormat } } }>(
      SCORE_FORMAT_QUERY,
      {},
      true,
    );
    return data.Viewer.mediaListOptions?.scoreFormat ?? null;
  } catch {
    return null;
  }
}

const SAVE_RATING_QUERY = `
mutation ($mediaId: Int, $scoreRaw: Int) {
  SaveMediaListEntry(mediaId: $mediaId, scoreRaw: $scoreRaw) { id score }
}`;

/** Set the cour entry's score (0–100 raw, format-agnostic). Requires auth. */
export async function saveRating(
  mediaId: number,
  scoreRaw: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await gql(SAVE_RATING_QUERY, { mediaId, scoreRaw }, true);
    return { ok: true };
  } catch (e) {
    if (e instanceof AniListNotConnectedError) throw e;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const SAVE_NOTES_QUERY = `
mutation ($mediaId: Int, $notes: String) {
  SaveMediaListEntry(mediaId: $mediaId, notes: $notes) { id notes }
}`;

/** Set the cour entry's private notes. Requires auth. */
export async function saveNotes(
  mediaId: number,
  notes: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await gql(SAVE_NOTES_QUERY, { mediaId, notes }, true);
    return { ok: true };
  } catch (e) {
    if (e instanceof AniListNotConnectedError) throw e;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
