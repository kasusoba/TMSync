/**
 * WeTrakr's part of applying a list sync plan (docs/ARCHITECTURE.md section 7): one
 * `POST /sync/tracking` for the watches, a second one for the statuses (after the
 * watches, which can move a show's list), one `POST /sync/ratings` for the
 * ratings, and one `POST /sync/ratings/remove` for the ratings to clear, per
 * chunk. Each watch write logs a play, so the plan never sends one twice (it
 * diffs against what WeTrakr has). Sync removes nothing from WeTrakr.
 */
import { errorMessage } from "../../errors";
import { wetrakrRatings } from "../../storage";
import { givesStatus } from "../../sync/plan/status";
import type { ChunkOutcome, SyncWrite, TargetRef, WriteOutcome } from "../../sync/types";
import { outcomes, sleep, toTen } from "../../sync/write-util";
import type { CourStatus } from "../cour-plan";
import { WetrakrNotConnectedError, syncPost } from "./client";

/** Writes per chunk (items per POST; WeTrakr takes up to 5,000). */
export const WETRAKR_CHUNK = 100;

/** WeTrakr allows 60 writes a minute per user. */
const GAP_MS = 1_100;

/** How a body names an item: its WeTrakr id, else ONE external id (WeTrakr matches
 * by one). Null when there is none. Pure. */
export function wetrakrRef(t: TargetRef): Record<string, unknown> | null {
  if (t.id !== undefined) return { id: t.id };
  if (t.ids.tmdb !== undefined) return { ids: { tmdb: t.ids.tmdb } };
  if (t.ids.imdb) return { ids: { imdb: t.ids.imdb } };
  if (t.ids.tvdb !== undefined) return { ids: { tvdb: t.ids.tvdb } };
  return null;
}

/** When a backfilled watch happened: the source's date, else the release date. Pure. */
const when = (at?: number) =>
  at !== undefined ? { tracked_at: new Date(at).toISOString() } : { use_release_date: true };

/** The `/sync/tracking` body for the watch writes, and which writes it holds. Each
 * episode carries its own `watched` status, so the show's own status is untouched.
 * Episodes with no season cannot go to WeTrakr. Pure. */
export function trackingBody(writes: SyncWrite[]): {
  body: Record<string, unknown[]>;
  at: number[];
} {
  const movies: unknown[] = [];
  const shows: unknown[] = [];
  const at: number[] = [];
  writes.forEach((w, i) => {
    if (w.op !== "movie" && w.op !== "episodes") return;
    const ref = wetrakrRef(w.target);
    if (!ref) return;
    if (w.op === "movie") {
      movies.push({ ...ref, status: "watched", ...when(w.at) });
      at.push(i);
      return;
    }
    const seasons = new Map<number, unknown[]>();
    for (const ep of w.add) {
      if (ep.season === undefined) continue;
      const list = seasons.get(ep.season) ?? [];
      list.push({ number: ep.number, status: "watched", ...when(w.at) });
      seasons.set(ep.season, list);
    }
    if (!seasons.size) return;
    shows.push({
      ...ref,
      seasons: [...seasons].map(([number, episodes]) => ({ number, episodes })),
    });
    at.push(i);
  });
  return { body: { movies, shows }, at };
}

/** A status as a WeTrakr tracking list. A status WeTrakr cannot hold on the item
 * clears the one it has (`none` never deletes plays). */
const COUR_TO_WETRAKR: Partial<Record<CourStatus, string>> = {
  PLANNING: "planning",
  CURRENT: "watching",
  PAUSED: "paused",
  DROPPED: "dropped",
};

/** The `/sync/tracking` body for the status writes, and which writes it holds. A
 * show's status is its own (no nested seasons), so it marks no episode. Pure. */
export function statusBody(writes: SyncWrite[]): {
  body: Record<string, unknown[]>;
  at: number[];
} {
  const movies: unknown[] = [];
  const shows: unknown[] = [];
  const at: number[] = [];
  writes.forEach((w, i) => {
    if (w.op !== "status") return;
    const ref = wetrakrRef(w.target);
    if (!ref) return;
    const movie = w.target.mediaType === "movie";
    const to = w.status.to;
    const status =
      to && givesStatus("wetrakr", movie ? "movie" : "show", to) ? COUR_TO_WETRAKR[to] : "none";
    (movie ? movies : shows).push({ ...ref, status });
    at.push(i);
  });
  return { body: { movies, shows }, at };
}

/** The `/sync/ratings` body (or, with `unrate`, the `/sync/ratings/remove` body),
 * and which writes it holds. A season rating nests in its show. Pure. */
export function ratingsBody(
  writes: SyncWrite[],
  op: "rating" | "unrate" = "rating",
): { body: Record<string, unknown[]>; at: number[] } {
  const movies: unknown[] = [];
  const shows: unknown[] = [];
  const at: number[] = [];
  writes.forEach((w, i) => {
    if (w.op !== op || (w.op !== "rating" && w.op !== "unrate")) return;
    const ref = wetrakrRef(w.target);
    if (!ref) return;
    const rating = w.op === "rating" ? { rating: toTen(w.score) } : {};
    if (w.level === "movie") movies.push({ ...ref, ...rating });
    else if (w.level === "show") shows.push({ ...ref, ...rating });
    else if (w.level === "season" && w.season !== undefined)
      shows.push({ ...ref, seasons: [{ number: w.season, ...rating }] });
    else return;
    at.push(i);
  });
  return { body: { movies, shows }, at };
}

/**
 * Whether WeTrakr's `notFound` names this item. It echoes what it could not resolve
 * as it was sent, so an echo is ours when its id or ids match. Pure.
 */
export function inNotFound(
  data: unknown,
  ref: Record<string, unknown>,
  key: "notFound" | "errored" = "notFound",
): boolean {
  const nf = (data as Record<string, Record<string, unknown> | undefined> | undefined)?.[key];
  if (!nf || typeof nf !== "object") return false;
  const want = JSON.stringify(ref.id ?? ref.ids);
  return Object.values(nf).some(
    (list) =>
      Array.isArray(list) &&
      list.some((x) => {
        const echo = x as { id?: unknown; ids?: unknown } | null;
        return JSON.stringify(echo?.id ?? echo?.ids) === want;
      }),
  );
}

export async function applyWetrakr(writes: SyncWrite[]): Promise<ChunkOutcome> {
  const results = outcomes(writes.length, {
    ok: false,
    reason: "failed",
    error: "WeTrakr takes no list entries.",
  });
  const parts = [
    { path: "/sync/tracking" as const, ...trackingBody(writes) },
    { path: "/sync/tracking" as const, ...statusBody(writes) },
    { path: "/sync/ratings" as const, ...ratingsBody(writes) },
    { path: "/sync/ratings/remove" as const, ...ratingsBody(writes, "unrate") },
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
      if (res.status === 429) stop = "WeTrakr is limiting requests. Preview again later to finish.";
      else if (res.status === 420) stop = "WeTrakr says this account is at its plan limit.";
      else if (res.status === 423) stop = "WeTrakr has locked this app. See wetrakr.com/support.";
      if (res.status < 200 || res.status >= 300) {
        set({
          ok: false,
          reason: "failed",
          error: `WeTrakr ${res.status}${res.error ? `: ${res.error}` : ""}`,
        });
        continue;
      }
      for (const i of part.at) {
        const ref = wetrakrRef((writes[i] as SyncWrite).target) ?? {};
        results[i] = inNotFound(res.data, ref)
          ? { ok: false, reason: "not_found", error: "WeTrakr could not match it." }
          : inNotFound(res.data, ref, "errored")
            ? { ok: false, reason: "failed", error: "WeTrakr did not take it." }
            : { ok: true };
      }
      if (part.path !== "/sync/tracking") rated = true;
    } catch (e) {
      if (e instanceof WetrakrNotConnectedError) stop = "WeTrakr is not connected.";
      set({ ok: false, reason: "failed", error: errorMessage(e) });
    }
  }
  // The rating panel keeps a local copy of WeTrakr ratings: drop it, so it reads
  // what sync just wrote.
  if (rated) await wetrakrRatings.setValue({}).catch(() => {});
  return { results, stop };
}
