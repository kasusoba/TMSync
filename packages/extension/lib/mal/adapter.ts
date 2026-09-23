import type { ParsedMedia } from "@tmsync/shared";
import { errorMessage } from "../errors";
import type { TrackerAdapter } from "../tracker/adapter";
import {
  type CourEntry,
  type CourPlan,
  planCourWrite,
  planRewatchConfirm,
} from "../tracker/cour-plan";
import type {
  RatingLevel,
  RecordPhase,
  RecordResult,
  TrackedItem,
  WatchedState,
} from "../tracker/types";
import { isConnected } from "./auth";
import {
  ENTRY_FRESH_MS,
  type MalListFields,
  MalNotConnectedError,
  MalRateLimitError,
  correctionFor,
  getAnime,
  getListEntry,
  resolve as malResolve,
  resolveViaAniList,
  updateListStatus,
} from "./client";
import type { MalIdentity } from "./types";

type MalItem = Extract<TrackedItem, { tracker: "mal" }>;

function toItem(identity: MalIdentity): MalItem {
  return {
    tracker: "mal",
    mediaType: "show",
    id: identity.id,
    title: identity.title,
    year: identity.year,
    episodes: identity.episodes,
  };
}

/** A failed call as a RecordResult (never thrown into the background). */
function failure(e: unknown): RecordResult {
  if (e instanceof MalNotConnectedError) return { ok: false, reason: "not_connected" };
  return { ok: false, reason: "http", httpError: errorMessage(e) };
}

/**
 * A cour plan's write as MAL list fields. MAL has no REPEATING status: a rewatch
 * is a `completed` entry with `is_rewatching` set, and finishing it clears the flag
 * and bumps `num_times_rewatched`. Pure.
 */
export function planToFields(plan: Extract<CourPlan, { kind: "write" }>): MalListFields {
  switch (plan.status) {
    case "REPEATING":
      return { status: "completed", is_rewatching: true, num_watched_episodes: plan.progress };
    case "COMPLETED":
      return {
        status: "completed",
        is_rewatching: false,
        num_watched_episodes: plan.progress,
        ...(plan.repeat !== undefined ? { num_times_rewatched: plan.repeat } : {}),
      };
    default:
      return { status: "watching", num_watched_episodes: plan.progress };
  }
}

/** Apply a computed plan to MAL and map the outcome to a RecordResult. Shared by
 * the threshold path and the explicit rewatch confirmation. */
async function applyPlan(item: MalItem, plan: CourPlan): Promise<RecordResult> {
  switch (plan.kind) {
    case "noop":
      return { ok: true };
    case "already_watched":
      return { ok: true, info: "already_watched", atEpisode: plan.progress };
    case "no_episode":
      return { ok: false, reason: "no_episode" };
    case "mismatch":
      return {
        ok: false,
        reason: "numbering_mismatch",
        httpError: `episode ${plan.episode} > ${plan.total} on “${item.title}” · this site's numbering doesn't match MyAnimeList`,
      };
    case "needs_rewatch":
      return { ok: false, reason: "needs_rewatch" };
    case "write": {
      try {
        const out = await updateListStatus(item.id, planToFields(plan));
        if (!out.ok) return { ok: false, reason: "http", httpError: out.error };
        return { ok: true, action: "scrobble", completed: plan.completed };
      } catch (e) {
        return failure(e);
      }
    }
  }
}

/** The viewer's entry, or the RecordResult to return when it can't be read. A
 * failed read must never be planned as "not on the list". */
async function readEntry(
  item: MalItem,
  maxAgeMs = 0,
): Promise<{ entry: CourEntry | null } | { fail: RecordResult }> {
  try {
    return { entry: await getListEntry(item.id, maxAgeMs) };
  } catch (e) {
    return { fail: failure(e) };
  }
}

/**
 * MyAnimeList behind the seam. Same model as AniList (the shared cour planner):
 * no scrobble API, start/pause only read, and a `stop` at/after `watchedThreshold`
 * writes the transition once, never lowering progress. A completed entry is never
 * changed without an explicit rewatch confirmation.
 */
export const malAdapter: TrackerAdapter = {
  tracker: "mal",

  // A MAL id resolves directly. An AniList id also reaches MAL without the
  // crosswalk (resolveById, via `idMal`), but AniList claims that namespace first.
  resolvableNamespaces: ["mal"],

  isConnected,

  async resolve(media: ParsedMedia): Promise<TrackedItem | null> {
    const identity = await malResolve(media);
    return identity ? toItem(identity) : null;
  },

  async resolveById(ids, media) {
    // A title pin made on the MAL row wins, also when MAL follows AniList's entry.
    // A page with a tmdb id pins MAL through the tmdb + season crosswalk override
    // instead (deriveMediaWith). Its derived media has no season, so a title key
    // would match a pin for every season of the show.
    const pin = media.ids?.tmdb === undefined ? await correctionFor(media) : undefined;
    if (pin) return pin.identity ? toItem(pin.identity) : null;
    try {
      if (ids.mal !== undefined) {
        const identity = await getAnime(ids.mal);
        return identity ? toItem(identity) : null;
      }
      if (ids.anilist !== undefined) {
        const identity = await resolveViaAniList(ids.anilist);
        return identity ? toItem(identity) : null;
      }
    } catch (e) {
      // Rate limits and a missing connection surface; other failures read as a miss.
      if (e instanceof MalRateLimitError || e instanceof MalNotConnectedError) throw e;
      return null;
    }
    return null;
  },

  async recordProgress(
    item: TrackedItem,
    media: ParsedMedia,
    progress: number,
    phase: RecordPhase,
    watchedThreshold: number,
  ): Promise<RecordResult> {
    if (item.tracker !== "mal") return { ok: false, reason: "unresolved" };
    // Say "connect MyAnimeList" from play onward, not only at the threshold.
    if (!(await isConnected())) return { ok: false, reason: "not_connected" };
    // Read on every phase so "already watched" and the rewatch prompt show early.
    // Start and pause may reuse a recent read; a stop (the write moment) reads MAL.
    const read = await readEntry(item, phase === "stop" ? 0 : ENTRY_FRESH_MS);
    if ("fail" in read) return read.fail;
    const plan = planCourWrite({
      phase,
      progress,
      watchedThreshold,
      episode: media.episode,
      total: item.episodes,
      entry: read.entry,
      rewatchConfirmed: false,
    });
    return applyPlan(item, plan);
  },

  async confirmRewatch(
    item: TrackedItem,
    media: ParsedMedia,
    watched: boolean,
  ): Promise<RecordResult> {
    if (item.tracker !== "mal") return { ok: false, reason: "unresolved" };
    const read = await readEntry(item);
    if ("fail" in read) return read.fail;
    const plan = planRewatchConfirm({
      episode: media.episode,
      total: item.episodes,
      entry: read.entry,
      watched,
    });
    return applyPlan(item, plan);
  },

  ratingLevels(_media: ParsedMedia): RatingLevel[] {
    // MAL scores the entry (the cour) only, 1 to 10.
    return ["cour"];
  },

  async watchedState(item: TrackedItem): Promise<WatchedState | null> {
    if (item.tracker !== "mal") return null;
    let entry: CourEntry | null;
    try {
      entry = await getListEntry(item.id, ENTRY_FRESH_MS);
    } catch (e) {
      if (e instanceof MalNotConnectedError) return null;
      throw e;
    }
    // Like AniList: one high-water mark, so no gaps are representable.
    const progress = entry?.progress ?? 0;
    const total = item.episodes;
    const caughtUp = entry?.status === "COMPLETED" || (total !== null && progress >= total);
    return {
      tracker: "mal",
      total,
      watchedCount: progress,
      lastWatched: progress > 0 ? { number: progress } : null,
      next: caughtUp ? null : { number: progress + 1 },
      hasGaps: false,
      completed: entry?.status === "COMPLETED",
      entry,
    };
  },
};
