import { errorMessage } from "../../errors";
/**
 * Trakt's part of applying a list sync plan (plans/list-sync.md, phase 2): one
 * `POST /sync/history` for the watches and one `POST /sync/ratings` per chunk.
 * Trakt keeps a new play for every history write, so the plan never sends one
 * twice (it diffs against what Trakt has). Trakt has no list entries and no
 * status, so it takes no `entry` or `remove` write.
 */
import { remoteRatings } from "../../storage";
import { inNotFound, outcomes, sleep, toTen } from "../../sync/pace";
import type { ChunkOutcome, SyncWrite, TargetRef, WriteOutcome } from "../../sync/types";
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

/** The `/sync/ratings` body for the rating writes, and which writes it holds. A
 * season rating nests in its show. Pure. */
export function ratingsBody(writes: SyncWrite[]): {
  body: Record<string, unknown[]>;
  at: number[];
} {
  const movies: unknown[] = [];
  const shows: unknown[] = [];
  const at: number[] = [];
  writes.forEach((w, i) => {
    if (w.op !== "rating") return;
    const rating = toTen(w.score);
    const ids = traktIds(w.target);
    if (w.level === "movie") movies.push({ ids, rating });
    else if (w.level === "show") shows.push({ ids, rating });
    else if (w.level === "season" && w.season !== undefined)
      shows.push({ ids, seasons: [{ number: w.season, rating }] });
    else return;
    at.push(i);
  });
  return { body: { movies, shows }, at };
}

export async function applyTrakt(writes: SyncWrite[]): Promise<ChunkOutcome> {
  const results = outcomes(writes.length, {
    ok: false,
    reason: "failed",
    error: "Trakt takes no list entries.",
  });
  const parts = [
    { path: "/sync/history" as const, ...historyBody(writes) },
    { path: "/sync/ratings" as const, ...ratingsBody(writes) },
  ].filter((p) => p.at.length);
  let stop: string | undefined;
  let rated = false;
  for (const part of parts) {
    const set = (r: WriteOutcome) => {
      for (const i of part.at) results[i] = r;
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
        results[i] = inNotFound(res.data, traktIds(w.target))
          ? { ok: false, reason: "not_found", error: "Trakt could not match it." }
          : { ok: true };
      }
      if (part.path === "/sync/ratings") rated = true;
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
