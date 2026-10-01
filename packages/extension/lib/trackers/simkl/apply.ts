/**
 * Simkl's part of applying a list sync plan (docs/ARCHITECTURE.md section 7). Per
 * chunk, at most five POSTs of the user's daily quota: `/sync/history/remove`,
 * `/sync/history` (watches, and an anime entry's episodes and status),
 * `/sync/add-to-list` (the status of a movie or show), `/sync/ratings`, and
 * `/sync/ratings/remove`. Never the scrobble endpoints, so no 20 s lock.
 *
 * Anime goes under `shows[]` on every sync endpoint (Simkl's docs:
 * `/sync/history/remove` ignores an `anime[]` array), with its cour ids, and
 * a cour count as top-level `episodes` (AniDB numbering, as Simkl keeps anime).
 */
import { errorMessage } from "../../errors";
import { simklRatings } from "../../storage";
import type { ChunkOutcome, SyncWrite, TargetRef, WriteOutcome } from "../../sync/types";
import { inNotFound, outcomes, sleep, toTen } from "../../sync/write-util";
import type { CourStatus } from "../cour-plan";
import { SimklNotConnectedError, simklPost } from "./client";
import { COUR_TO_SIMKL } from "./list";

/** Writes per chunk. Bigger chunks cost less of the daily quota. */
export const SIMKL_CHUNK = 250;

/** Simkl allows one POST a second. */
const GAP_MS = 1_100;

type Ids = Record<string, string | number>;

/** The ids Simkl matches an item by: its own id, else every id we have, as
 * strings. An anime sends only cour ids, since a TMDB show id names every cour
 * of the show. Pure. */
export function simklItemIds(t: TargetRef): Ids {
  const ids: Ids = {};
  if (t.id !== undefined) ids.simkl = t.id;
  const keys = t.anime
    ? (["mal", "anilist"] as const)
    : (["tmdb", "imdb", "tvdb", "mal", "anilist"] as const);
  for (const k of keys) {
    const v = t.ids[k];
    if (v !== undefined && v !== "") ids[k] = String(v);
  }
  return ids;
}

/** The section a target goes under. Anime is always a show on Simkl. Pure. */
const section = (t: TargetRef) => (t.mediaType === "movie" && !t.anime ? "movies" : "shows");

const date = (at?: number) => (at !== undefined ? { watched_at: new Date(at).toISOString() } : {});

type Body = Record<"movies" | "shows", unknown[]>;

/** The bodies a chunk needs, and which writes each holds. Pure. */
export function simklBodies(writes: SyncWrite[]): {
  history: { body: Body; at: number[] };
  ratings: { body: Body; at: number[] };
  unrate: { body: Body; at: number[] };
  remove: { body: Body; at: number[] };
  /** Statuses, each item with its own `to`. */
  status: { body: Body; at: number[] };
  /** Writes with nothing Simkl can take (a rewatch count), done as they are. */
  nothing: number[];
} {
  const empty = (): { body: Body; at: number[] } => ({ body: { movies: [], shows: [] }, at: [] });
  const history = empty();
  const ratings = empty();
  const unrate = empty();
  const remove = empty();
  const status = empty();
  const nothing: number[] = [];
  const put = (b: { body: Body; at: number[] }, w: SyncWrite, i: number, item: object) => {
    b.body[section(w.target)].push({ ids: simklItemIds(w.target), ...item });
    b.at.push(i);
  };
  writes.forEach((w, i) => {
    switch (w.op) {
      case "movie":
        return put(history, w, i, date(w.at));
      case "episodes": {
        const inSeason = w.add.filter((e) => e.season !== undefined);
        const bare = w.add.filter((e) => e.season === undefined);
        const seasons = new Map<number, object[]>();
        for (const e of inSeason) {
          const list = seasons.get(e.season as number) ?? [];
          list.push({ number: e.number, ...date(w.at) });
          seasons.set(e.season as number, list);
        }
        return put(history, w, i, {
          ...(seasons.size
            ? { seasons: [...seasons].map(([number, episodes]) => ({ number, episodes })) }
            : {}),
          ...(bare.length
            ? { episodes: bare.map((e) => ({ number: e.number, ...date(w.at) })) }
            : {}),
        });
      }
      case "entry": {
        const item: Record<string, unknown> = {};
        if (w.status?.to) item.status = COUR_TO_SIMKL[w.status.to];
        if (w.progress && w.progress.to > w.progress.from) {
          // An anime movie is one item: "completed" marks it watched.
          if (w.target.mediaType === "movie") item.status ??= "completed";
          else {
            const eps: object[] = [];
            for (let n = w.progress.from + 1; n <= w.progress.to; n += 1)
              eps.push({ number: n, ...date(w.at) });
            item.episodes = eps;
          }
        }
        if (!Object.keys(item).length) return nothing.push(i);
        return put(history, w, i, item);
      }
      case "rating":
        return put(ratings, w, i, { rating: toTen(w.score) });
      case "unrate":
        return put(unrate, w, i, {});
      case "remove":
        return put(remove, w, i, {});
      case "status":
        return w.status.to
          ? put(status, w, i, { to: COUR_TO_SIMKL[w.status.to] })
          : nothing.push(i);
    }
  });
  return { history, ratings, unrate, remove, status, nothing };
}

export async function applySimkl(writes: SyncWrite[]): Promise<ChunkOutcome> {
  const results = outcomes(writes.length, { ok: true });
  const { history, ratings, unrate, remove, status, nothing } = simklBodies(writes);
  for (const i of nothing) results[i] = { ok: true };
  const parts = [
    { path: "/sync/history/remove", ...remove },
    { path: "/sync/history", ...history },
    { path: "/sync/add-to-list", ...status },
    { path: "/sync/ratings", ...ratings },
    { path: "/sync/ratings/remove", ...unrate },
  ].filter((p) => p.at.length);
  let stop: string | undefined;
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
      const res = await simklPost(part.path, part.body);
      if (res.status === 429) stop = "Simkl is limiting requests. Preview again later to finish.";
      if (res.status < 200 || res.status >= 300) {
        set({
          ok: false,
          reason: "failed",
          error: `Simkl ${res.status}${res.error ? `: ${res.error}` : ""}`,
        });
        continue;
      }
      for (const i of part.at) {
        const w = writes[i] as SyncWrite;
        results[i] = inNotFound(res.data, simklItemIds(w.target))
          ? { ok: false, reason: "not_found", error: "Simkl could not match it." }
          : { ok: true };
      }
      if (part.path.startsWith("/sync/ratings")) await mirror(writes, part.at, results);
    } catch (e) {
      if (e instanceof SimklNotConnectedError) stop = "Simkl is not connected.";
      set({ ok: false, reason: "failed", error: errorMessage(e) });
    }
  }
  return { results, stop };
}

/** Keep the local rating mirror up to date (reading a rating back costs quota). Only
 * entries Simkl already named by id: that is the mirror's key. */
async function mirror(writes: SyncWrite[], at: number[], results: WriteOutcome[]) {
  const all = { ...(await simklRatings.getValue()) };
  for (const i of at) {
    const w = writes[i];
    if (w?.target.id === undefined || !results[i]?.ok) continue;
    if (w.op === "rating") all[`simkl:${w.target.id}`] = toTen(w.score);
    else if (w.op === "unrate") delete all[`simkl:${w.target.id}`];
  }
  await simklRatings.setValue(all).catch(() => {});
}
