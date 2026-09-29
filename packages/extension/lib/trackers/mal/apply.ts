/**
 * MyAnimeList's part of applying a list sync plan (docs/ARCHITECTURE.md section 7).
 * One PATCH (or DELETE) per entry, after a fresh read of it (`mergeCour`), so a
 * scrobble that landed since the preview is never undone. MAL answers bursts with
 * 403, so calls are spaced, and a 403 stops MAL for this run: never a retry loop.
 */
import { errorMessage } from "../../errors";
import { mergeCour } from "../../sync/merge";
import { byTarget, outcomes, sleep, toTen } from "../../sync/pace";
import type { ChunkOutcome, SyncWrite, TargetRef } from "../../sync/types";
import type { CourStatus } from "../cour-plan";
import type { ApplyReport } from "../service";
import {
  type MalListFields,
  MalNotConnectedError,
  MalRateLimitError,
  deleteListStatus,
  getMyListStatus,
  syncListStatus,
  toCourEntry,
} from "./client";

/** Entries per chunk: the position is saved after each. */
export const MAL_CHUNK = 10;

/** Space between requests. */
const GAP_MS = 1_500;

const malId = (t: TargetRef) => t.id ?? t.ids.mal;

/** A cour status in MAL's words. MAL has no rewatching status: it is a completed
 * entry with `is_rewatching` set. Pure. */
export function malFields(a: {
  progress?: number;
  status?: CourStatus;
  repeat?: number;
  score?: number;
}): MalListFields {
  const out: MalListFields = {};
  if (a.status === "REPEATING") {
    out.status = "completed";
    out.is_rewatching = true;
  } else if (a.status) {
    out.status = (
      {
        CURRENT: "watching",
        PLANNING: "plan_to_watch",
        COMPLETED: "completed",
        PAUSED: "on_hold",
        DROPPED: "dropped",
      } as const
    )[a.status];
  }
  if (a.progress !== undefined) out.num_watched_episodes = a.progress;
  if (a.repeat !== undefined) out.num_times_rewatched = a.repeat;
  // MAL reads a score of 0 as "not rated": that is how a rating is cleared.
  if (a.score !== undefined) out.score = a.score === 0 ? 0 : toTen(a.score);
  return out;
}

function stopFor(e: unknown): string | undefined {
  if (e instanceof MalNotConnectedError) return "MyAnimeList is not connected.";
  if (e instanceof MalRateLimitError)
    return "MyAnimeList is limiting requests. Preview again later to finish.";
  return undefined;
}

export async function applyMal(writes: SyncWrite[], report?: ApplyReport): Promise<ChunkOutcome> {
  const results = outcomes(writes.length, { ok: true });
  let stop: string | undefined;
  for (const g of byTarget(writes)) {
    const set = (r: (typeof results)[number]) => {
      for (const i of g.at) results[i] = r;
      report?.(g.at, r);
    };
    if (stop) {
      set({ ok: false, reason: "failed", error: "Not sent." });
      continue;
    }
    const id = malId(g.target);
    if (id === undefined) {
      set({ ok: false, reason: "failed", error: "No MyAnimeList id." });
      continue;
    }
    try {
      await sleep(GAP_MS);
      const raw = await getMyListStatus(id);
      const entry = raw ? toCourEntry(raw) : null;
      const fresh = entry && { ...entry, score: raw?.score ? raw.score * 10 : null };
      const action = mergeCour(
        g.at.map((i) => writes[i] as SyncWrite),
        fresh,
      );
      if (action.kind === "delete") {
        await sleep(GAP_MS);
        await deleteListStatus(id);
      } else if (action.kind === "save") {
        await sleep(GAP_MS);
        await syncListStatus(id, malFields(action));
      } else {
        set({ ok: true, reason: "changed" });
        continue;
      }
      set({ ok: true });
    } catch (e) {
      stop = stopFor(e);
      const gone = /has no anime/.test(errorMessage(e));
      set({ ok: false, reason: gone ? "not_found" : "failed", error: errorMessage(e) });
    }
  }
  return { results, stop };
}
