/**
 * Trakt's part of applying a list sync plan (docs/ARCHITECTURE.md section 7). Per
 * chunk, one POST each for what it holds: `/sync/history` for the watches,
 * `/sync/ratings` and `/sync/ratings/remove`, and for statuses
 * `/sync/watchlist` (plan to watch) and `/users/hidden/dropped` (dropped shows),
 * each with its `/remove`. Trakt keeps a new play for every history write, so
 * the plan never sends one twice (it diffs against what Trakt has). Trakt has no
 * list entries, so it takes no `entry` or `remove` write.
 */
import { errorMessage } from "../../errors";
import { remoteRatings } from "../../storage";
import type { ChunkOutcome, SyncWrite, TargetRef, WriteOutcome } from "../../sync/types";
import { inNotFound, sleep, toTen } from "../../sync/write-util";
import { TraktNotConnectedError, syncPost } from "./client";

/** Writes per chunk (items per POST). */
export const TRAKT_CHUNK = 100;

/** Trakt allows about one POST a second. */
const GAP_MS = 1_100;

type Ids = Record<string, string | number>;

/** The ids Trakt matches an item by. Pure. */
export function traktIds(t: TargetRef): Ids {
  const ids: Ids = {};
  if (t.id !== undefined) ids.trakt = t.id;
  if (t.ids.tmdb !== undefined) ids.tmdb = t.ids.tmdb;
  if (t.ids.imdb) ids.imdb = t.ids.imdb;
  if (t.ids.tvdb !== undefined) ids.tvdb = t.ids.tvdb;
  return ids;
}

/** When a backfilled watch happened: the source's date, else the air date. Pure. */
const watchedAt = (at?: number) => (at !== undefined ? new Date(at).toISOString() : "released");

/** The `/sync/history` body for the watch writes (movie, episodes), and which
 * writes it holds. Episodes with no season cannot go to Trakt. Pure. */
export function historyBody(writes: SyncWrite[]): {
  body: Record<string, unknown[]>;
  at: number[];
} {
  const movies: unknown[] = [];
  const shows: unknown[] = [];
  const at: number[] = [];
  writes.forEach((w, i) => {
    if (w.op === "movie") {
      movies.push({ ids: traktIds(w.target), watched_at: watchedAt(w.at) });
      at.push(i);
    } else if (w.op === "episodes") {
      const seasons = new Map<number, { number: number; watched_at: string }[]>();
      for (const ep of w.add) {
        if (ep.season === undefined) continue;
        const list = seasons.get(ep.season) ?? [];
        list.push({ number: ep.number, watched_at: watchedAt(w.at) });
        seasons.set(ep.season, list);
      }
      if (!seasons.size) return;
      shows.push({
        ids: traktIds(w.target),
        seasons: [...seasons].map(([number, episodes]) => ({ number, episodes })),
      });
      at.push(i);
    }
  });
  return { body: { movies, shows }, at };
}

/** The `/sync/ratings` body for the rating writes (or, with `unrate`, the
 * `/sync/ratings/remove` body for the ratings to clear), and which writes it
 * holds. A season rating nests in its show. Pure. */
export function ratingsBody(
  writes: SyncWrite[],
  op: "rating" | "unrate" = "rating",
): {
  body: Record<string, unknown[]>;
  at: number[];
} {
  const movies: unknown[] = [];
  const shows: unknown[] = [];
  const at: number[] = [];
  writes.forEach((w, i) => {
    if (w.op !== op || (w.op !== "rating" && w.op !== "unrate")) return;
    // A removal names the item only.
    const rating = w.op === "rating" ? { rating: toTen(w.score) } : {};
    const ids = traktIds(w.target);
    if (w.level === "movie") movies.push({ ids, ...rating });
    else if (w.level === "show") shows.push({ ids, ...rating });
    else if (w.level === "season" && w.season !== undefined)
      shows.push({ ids, seasons: [{ number: w.season, ...rating }] });
    else return;
    at.push(i);
  });
  return { body: { movies, shows }, at };
}

/** The status writes as the four Trakt lists they move between: which go on or
 * off the watchlist, and which shows are dropped or undropped. Pure. */
export function statusBodies(
  writes: SyncWrite[],
): Record<
  | "/sync/watchlist"
  | "/sync/watchlist/remove"
  | "/users/hidden/dropped"
  | "/users/hidden/dropped/remove",
  { body: Record<string, unknown[]>; at: number[] }
> {
  const empty = () => ({
    body: { movies: [] as unknown[], shows: [] as unknown[] },
    at: [] as number[],
  });
  const out = {
    "/sync/watchlist": empty(),
    "/sync/watchlist/remove": empty(),
    "/users/hidden/dropped": empty(),
    "/users/hidden/dropped/remove": empty(),
  };
  writes.forEach((w, i) => {
    if (w.op !== "status") return;
    const { from, to } = w.status;
    const key = w.target.mediaType === "movie" ? "movies" : "shows";
    const put = (path: keyof typeof out) => {
      out[path].body[key]?.push({ ids: traktIds(w.target) });
      out[path].at.push(i);
    };
    if (to === "PLANNING") put("/sync/watchlist");
    else if (from === "PLANNING") put("/sync/watchlist/remove");
    if (key === "shows" && to === "DROPPED") put("/users/hidden/dropped");
    else if (key === "shows" && from === "DROPPED") put("/users/hidden/dropped/remove");
  });
  return out;
}

export async function applyTrakt(writes: SyncWrite[]): Promise<ChunkOutcome> {
  const parts = [
    { path: "/sync/history" as const, ...historyBody(writes) },
    { path: "/sync/ratings" as const, ...ratingsBody(writes) },
    { path: "/sync/ratings/remove" as const, ...ratingsBody(writes, "unrate") },
    ...Object.entries(statusBodies(writes)).map(([path, b]) => ({
      path: path as keyof ReturnType<typeof statusBodies>,
      ...b,
    })),
  ].filter((p) => p.at.length);
  // A write in some part is done unless one of its parts fails (a status can take
  // two: off the watchlist, onto the dropped list).
  const sent = new Set(parts.flatMap((p) => p.at));
  const results = writes.map(
    (_, i): WriteOutcome =>
      sent.has(i)
        ? { ok: true }
        : { ok: false, reason: "failed", error: "Trakt takes no list entries." },
  );
  let stop: string | undefined;
  let rated = false;
  for (const part of parts) {
    const set = (r: WriteOutcome) => {
      for (const i of part.at) if (results[i]?.ok) results[i] = r;
    };
    if (stop) {
      set({ ok: false, reason: "failed", error: "Not sent." });
      continue;
    }
    await sleep(GAP_MS);
    try {
      const res = await syncPost(part.path, part.body);
      if (res.status === 429) stop = "Trakt is limiting requests. Preview again later to finish.";
      else if (res.status === 420) stop = "Trakt says this account is at its limit.";
      if (res.status < 200 || res.status >= 300) {
        set({
          ok: false,
          reason: "failed",
          error: `Trakt ${res.status}${res.error ? `: ${res.error}` : ""}`,
        });
        continue;
      }
      for (const i of part.at) {
        const w = writes[i] as SyncWrite;
        if (results[i]?.ok && inNotFound(res.data, traktIds(w.target)))
          results[i] = { ok: false, reason: "not_found", error: "Trakt could not match it." };
      }
      if (part.path.startsWith("/sync/ratings")) rated = true;
    } catch (e) {
      if (e instanceof TraktNotConnectedError) stop = "Trakt is not connected.";
      set({ ok: false, reason: "failed", error: errorMessage(e) });
    }
  }
  // The rating panel reads Trakt ratings through a cache: drop it, so it shows
  // what sync just wrote.
  if (rated) await remoteRatings.setValue({}).catch(() => {});
  return { results, stop };
}
