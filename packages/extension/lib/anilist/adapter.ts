import type { ParsedMedia } from "@tmsync/shared";
import type { TrackerAdapter } from "../tracker/adapter";
import type {
  RatingLevel,
  RecordPhase,
  RecordResult,
  TrackedItem,
  WatchedState,
} from "../tracker/types";
import { isConnected } from "./auth";
import {
  AniListNotConnectedError,
  resolve as anilistResolve,
  getListEntry,
  saveEntry,
} from "./client";
import { type AniListPlan, planAniListWrite } from "./util";

type AniListItem = Extract<TrackedItem, { tracker: "anilist" }>;

/**
 * Apply a computed plan to AniList: perform the SaveMediaListEntry write (or not)
 * and map the outcome to a RecordResult. Shared by the normal threshold path and
 * the explicit rewatch confirmation.
 */
async function applyPlan(item: AniListItem, plan: AniListPlan): Promise<RecordResult> {
  switch (plan.kind) {
    case "noop":
      return { ok: true };
    case "no_episode":
      return { ok: false, reason: "no_episode" };
    case "mismatch":
      // Fail visibly, never silently corrupt (step 6).
      return {
        ok: false,
        reason: "numbering_mismatch",
        httpError: `episode ${plan.episode} > ${plan.total} on “${item.title}” — this site's numbering doesn't match AniList`,
      };
    case "needs_rewatch":
      // Completed cour — write nothing; the badge asks the user to confirm first.
      return { ok: false, reason: "needs_rewatch" };
    case "write": {
      try {
        const out = await saveEntry(item.id, {
          progress: plan.progress,
          status: plan.status,
          ...(plan.repeat !== undefined ? { repeat: plan.repeat } : {}),
        });
        if (!out.ok) return { ok: false, reason: "http", httpError: out.error };
        return { ok: true, action: "scrobble", completed: plan.completed };
      } catch (e) {
        if (e instanceof AniListNotConnectedError) return { ok: false, reason: "not_connected" };
        throw e;
      }
    }
  }
}

/**
 * AniList behind the seam. No scrobble API: start/pause are no-ops, and a `stop`
 * at/after `watchedThreshold` reads the viewer's current entry and writes the
 * right transition (CURRENT → COMPLETED → REPEATING), never lowering progress.
 * A COMPLETED cour is never mutated without an explicit rewatch confirmation
 * (`confirmRewatch`).
 */
export const anilistAdapter: TrackerAdapter = {
  tracker: "anilist",

  isConnected,

  async resolve(media: ParsedMedia): Promise<TrackedItem | null> {
    const identity = await anilistResolve(media);
    if (!identity) return null;
    return {
      tracker: "anilist",
      mediaType: "show",
      id: identity.id,
      title: identity.title,
      year: identity.year,
      episodes: identity.episodes,
    };
  },

  async recordProgress(
    item: TrackedItem,
    media: ParsedMedia,
    progress: number,
    phase: RecordPhase,
    watchedThreshold: number,
  ): Promise<RecordResult> {
    if (item.tracker !== "anilist") return { ok: false, reason: "unresolved" };
    // Only a finished stop touches AniList — skip the entry read for start/pause.
    if (phase !== "stop") return { ok: true };

    let entry: Awaited<ReturnType<typeof getListEntry>>;
    try {
      entry = await getListEntry(item.id);
    } catch (e) {
      if (e instanceof AniListNotConnectedError) return { ok: false, reason: "not_connected" };
      throw e;
    }
    const plan = planAniListWrite({
      phase,
      progress,
      watchedThreshold,
      episode: media.episode,
      total: item.episodes,
      entry,
      rewatchConfirmed: false,
    });
    return applyPlan(item, plan);
  },

  ratingLevels(_media: ParsedMedia): RatingLevel[] {
    // AniList rates the cour entry only — no per-episode, no franchise-wide score.
    return ["cour"];
  },

  async watchedState(item: TrackedItem): Promise<WatchedState | null> {
    if (item.tracker !== "anilist") return null;
    let entry: Awaited<ReturnType<typeof getListEntry>>;
    try {
      entry = await getListEntry(item.id);
    } catch (e) {
      if (e instanceof AniListNotConnectedError) return null; // not connected → nothing to show
      throw e;
    }
    // AniList stores a single high-water mark — no gaps are representable. No entry
    // yet ⇒ nothing watched. `next` is the episode after `progress` unless the cour
    // is fully caught up (a known total reached / COMPLETED).
    const progress = entry?.progress ?? 0;
    const total = item.episodes;
    const caughtUp = entry?.status === "COMPLETED" || (total !== null && progress >= total);
    return {
      tracker: "anilist",
      total,
      watchedCount: progress,
      lastWatched: progress > 0 ? { number: progress } : null,
      next: caughtUp ? null : { number: progress + 1 },
      hasGaps: false,
    };
  },
};

/**
 * Explicit rewatch confirmation for a COMPLETED cour (the user said yes to the
 * badge prompt). Reads the entry, plans with `rewatchConfirmed: true`, and writes
 * REPEATING (or re-COMPLETED + repeat++ on the final episode). Forces the
 * threshold check to pass since this is a deliberate action.
 */
export async function confirmAniListRewatch(
  item: AniListItem,
  media: ParsedMedia,
): Promise<RecordResult> {
  let entry: Awaited<ReturnType<typeof getListEntry>>;
  try {
    entry = await getListEntry(item.id);
  } catch (e) {
    if (e instanceof AniListNotConnectedError) return { ok: false, reason: "not_connected" };
    throw e;
  }
  const plan = planAniListWrite({
    phase: "stop",
    progress: 100,
    watchedThreshold: 0,
    episode: media.episode,
    total: item.episodes,
    entry,
    rewatchConfirmed: true,
  });
  return applyPlan(item, plan);
}
