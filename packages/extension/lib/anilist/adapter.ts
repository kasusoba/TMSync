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
  resolveById,
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
    case "already_watched":
      // Benign: the episode is at/below AniList's recorded progress, so it won't
      // advance. Report it (not a silent "stopped") — never lower remote progress.
      return { ok: true, info: "already_watched", atEpisode: plan.progress };
    case "no_episode":
      return { ok: false, reason: "no_episode" };
    case "mismatch":
      // Fail visibly, never silently corrupt (step 6).
      return {
        ok: false,
        reason: "numbering_mismatch",
        httpError: `episode ${plan.episode} > ${plan.total} on “${item.title}” · this site's numbering doesn't match AniList`,
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

  // AniList resolves an anilist Media id directly, or a MAL id via `Media(idMal:)`.
  // A tmdb/imdb page id reaches AniList only through the crosswalk (derived path).
  resolvableNamespaces: ["anilist", "mal"],

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
    // Surface the not-connected state on the FIRST event (play), not only when the
    // threshold write fails at stop. AniList has no scrobble API, so start/pause
    // never write — but without this gate the badge shows "watching"/"paused" for a
    // whole episode and then abruptly errors "connect AniList" at the threshold.
    // Checking here (a cheap token read, no network) makes the badge say "connect
    // AniList" from play onward. Applies to the derived (multi-track) path too.
    if (!(await isConnected())) return { ok: false, reason: "not_connected" };

    // Read the entry on EVERY phase (not just stop). AniList still writes only at the
    // threshold, but reading at play lets us surface "already watched" (episode ≤
    // recorded progress → won't advance) and the rewatch prompt UP FRONT, instead of
    // a confusing "stopped" once the threshold passes. One cheap read per phase.
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
 * Resolve a KNOWN AniList id → a TrackedItem (multi-track derived path). The
 * crosswalk already gave us the exact entry, so we resolve by id (episodes/title)
 * rather than a title search.
 */
export async function resolveAniListById(anilistId: number): Promise<AniListItem | null> {
  const identity = await resolveById(anilistId);
  if (!identity) return null;
  return {
    tracker: "anilist",
    mediaType: "show",
    id: identity.id,
    title: identity.title,
    year: identity.year,
    episodes: identity.episodes,
  };
}

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
