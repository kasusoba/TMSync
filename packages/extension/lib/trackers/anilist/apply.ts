/**
 * AniList's part of applying a list sync plan (plans/list-sync.md, phase 2). One
 * `SaveMediaListEntry` per entry (or `DeleteMediaListEntry` for a removal), each
 * merged with a fresh read of the entry first (`mergeCour`), so a scrobble that
 * landed since the preview is never undone.
 */
import { errorMessage } from "../../errors";
import { mergeCour } from "../../sync/merge";
import { byTarget, outcomes, sleep } from "../../sync/pace";
import type { ChunkOutcome, SyncWrite, TargetRef } from "../../sync/types";
import {
  AniListHttpError,
  AniListNotConnectedError,
  deleteListEntry,
  readFreshEntries,
  syncSaveEntry,
} from "./client";

/** Entries per chunk. The fresh read takes up to 50 at once. */
export const ANILIST_CHUNK = 25;

/** Space between requests. AniList allows 90 a minute, and 30 when it is under
 * load, which it often is. */
const GAP_MS = 2_100;

/** The longest `Retry-After` sync waits out before it gives up on AniList. */
const MAX_WAIT_S = 90;

const mediaId = (t: TargetRef) => t.id ?? t.ids.anilist;

/** Why AniList must stop for this run, or undefined for an error of one item. */
function stopFor(e: unknown): string | undefined {
  if (e instanceof AniListNotConnectedError) return "AniList is not connected.";
  if (e instanceof AniListHttpError && e.status === 429)
    return "AniList is limiting requests. Preview again later to finish.";
  return undefined;
}

/** One request, spaced from the last. A 429 waits out `Retry-After` once; a second
 * one throws, and the caller stops AniList (never a retry loop). */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  await sleep(GAP_MS);
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof AniListHttpError) || e.status !== 429) throw e;
    if ((e.retryAfter ?? 60) > MAX_WAIT_S) throw e;
    await sleep((e.retryAfter ?? 60) * 1000);
    return await fn();
  }
}

export async function applyAniList(writes: SyncWrite[]): Promise<ChunkOutcome> {
  const results = outcomes(writes.length, { ok: true });
  const groups = byTarget(writes);
  const ids = groups.flatMap((g) => {
    const id = mediaId(g.target);
    return id === undefined ? [] : [id];
  });

  let fresh: Awaited<ReturnType<typeof readFreshEntries>>;
  try {
    fresh = await call(() => readFreshEntries(ids));
  } catch (e) {
    return {
      results: outcomes(writes.length, { ok: false, reason: "failed", error: errorMessage(e) }),
      stop: stopFor(e) ?? `AniList could not be read: ${errorMessage(e)}`,
    };
  }

  let stop: string | undefined;
  for (const g of groups) {
    const set = (r: (typeof results)[number]) => {
      for (const i of g.at) results[i] = r;
    };
    if (stop) {
      set({ ok: false, reason: "failed", error: "Not sent." });
      continue;
    }
    const id = mediaId(g.target);
    if (id === undefined) {
      set({ ok: false, reason: "failed", error: "No AniList id." });
      continue;
    }
    const f = fresh.get(id);
    const action = mergeCour(
      g.at.map((i) => writes[i] as SyncWrite),
      f
        ? { status: f.status, progress: f.progress, repeat: f.repeat, score: f.score || null }
        : null,
    );
    try {
      if (action.kind === "delete" && f) await call(() => deleteListEntry(f.id));
      else if (action.kind === "save") {
        const { progress, status, repeat, score } = action;
        await call(() => syncSaveEntry(id, { progress, status, repeat, scoreRaw: score }));
      } else set({ ok: true, reason: "changed" });
    } catch (e) {
      stop = stopFor(e);
      set({ ok: false, reason: "failed", error: errorMessage(e) });
    }
  }
  return { results, stop };
}
