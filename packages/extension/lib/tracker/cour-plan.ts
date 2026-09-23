import type { RecordPhase } from "./types";

/**
 * List status of a cour-family entry, in AniList's vocabulary (MAL maps onto it:
 * watching = CURRENT, completed = COMPLETED, completed + is_rewatching = REPEATING,
 * on_hold = PAUSED, dropped = DROPPED, plan_to_watch = PLANNING). We READ all of
 * them to decide transitions but only ever WRITE CURRENT / COMPLETED / REPEATING.
 */
export type CourStatus = "CURRENT" | "PLANNING" | "COMPLETED" | "DROPPED" | "PAUSED" | "REPEATING";

/** The viewer's existing list entry (null when not on their list). */
export interface CourEntry {
  status: CourStatus | null;
  progress: number;
  /** Completed rewatches (AniList `repeat`, MAL `num_times_rewatched`). */
  repeat: number;
}

/**
 * The decision for a cour-family progress event (AniList, MAL), computed purely
 * (no I/O) so it can be unit-tested. Unlike Trakt, these trackers keep a per-cour
 * *status* (CURRENT / COMPLETED / REPEATING) plus a progress count and a rewatch
 * count, so we read the viewer's current entry and compute the right transition,
 * never lowering remote progress. Each adapter maps the plan onto its own API.
 *
 * Rewatch rule (per the user): a COMPLETED cour is **never silently mutated**.
 * Watching any episode of it yields `needs_rewatch` (a prompt) and writes nothing
 * until the user confirms; only then do we switch to REPEATING and track again.
 */
export type CourPlan =
  | { kind: "noop" } // start/pause, or stop below threshold — nothing to say yet
  | { kind: "already_watched"; episode: number; progress: number } // ep ≤ remote progress
  | { kind: "no_episode" } // a show with no scraped episode number
  | { kind: "mismatch"; episode: number; total: number } // numbering guardrail (step 6)
  | { kind: "needs_rewatch"; episode: number } // completed cour, awaiting confirmation
  | {
      kind: "write";
      progress: number;
      status: CourStatus;
      repeat?: number;
      /** True when this write finishes the cour (drives the rating prompt). */
      completed: boolean;
    };

export interface CourPlanInput {
  phase: RecordPhase;
  /** 0–100. */
  progress: number;
  /** 0–1. */
  watchedThreshold: number;
  /** Scraped episode number (undefined ⇒ can't write). */
  episode: number | undefined;
  /** Entry total episodes; null ⇒ unknown/ongoing (guardrail + "final" can't fire). */
  total: number | null;
  /** The viewer's current list entry (null ⇒ not on their list / not connected). */
  entry: CourEntry | null;
  /**
   * Whether the user has just confirmed a rewatch of a COMPLETED cour. Normal
   * threshold writes pass false (→ `needs_rewatch`); the explicit confirm passes
   * true (→ writes REPEATING / re-COMPLETED).
   */
  rewatchConfirmed: boolean;
}

const EMPTY: CourEntry = { status: null, progress: 0, repeat: 0 };

/**
 * Decide what (if anything) to write to a cour tracker for a progress phase, given the
 * viewer's current entry. Only a `stop` at/after `watchedThreshold` counts as
 * watched. Idempotent: never lowers progress within a status, never re-writes an
 * already-counted episode.
 */
export function planCourWrite(input: CourPlanInput): CourPlan {
  const { phase, progress, watchedThreshold, episode, total, rewatchConfirmed } = input;
  const entry = input.entry ?? EMPTY;
  const atThreshold = phase === "stop" && progress >= watchedThreshold * 100;

  if (episode === undefined) {
    // Only worth flagging a missing episode when we'd otherwise write (a finished stop).
    return atThreshold ? { kind: "no_episode" } : { kind: "noop" };
  }
  // Guardrail: a scraped episode beyond the entry's total is a numbering mismatch —
  // surface it on any phase (early), not only at the threshold.
  if (total !== null && episode > total) return { kind: "mismatch", episode, total };

  const isFinal = total !== null && episode >= total;

  // A COMPLETED cour is sacred: never mutate it on a stray replay. Prompt on ANY
  // episode/phase (upfront — the CLAUDE.md rewatch rule), write only once confirmed.
  if (entry.status === "COMPLETED" && !rewatchConfirmed) {
    return { kind: "needs_rewatch", episode };
  }

  // Already counted this episode: we never lower progress, so nothing will be
  // written. Report it on ANY phase (so the user learns at PLAY, not via a confusing
  // "stopped" once the threshold passes) rather than a silent noop. NOT for a just-
  // confirmed rewatch of a COMPLETED cour — that resets tracking and must write below.
  if (
    (entry.status === "CURRENT" || entry.status === "REPEATING") &&
    !isFinal &&
    episode <= entry.progress
  ) {
    return { kind: "already_watched", episode, progress: entry.progress };
  }

  // A rewatch confirmed before this episode is watched (the prompt shows before
  // play): start the rewatch at the episode before it, so an episode the user
  // never finishes is never counted. Its own stop at the threshold counts it.
  if (entry.status === "COMPLETED" && rewatchConfirmed && !atThreshold) {
    return {
      kind: "write",
      progress: Math.max(0, episode - 1),
      status: "REPEATING",
      completed: false,
    };
  }

  // Not a write moment yet (start/pause, or a stop below threshold) → nothing to do.
  if (!atThreshold) return { kind: "noop" };

  // --- write paths (finished stop, and this episode advances progress) ---
  // A confirmed rewatch of a COMPLETED cour: REPEATING until the final episode
  // re-completes it (+1 repeat).
  if (entry.status === "COMPLETED") {
    return isFinal
      ? {
          kind: "write",
          progress: total ?? episode,
          status: "COMPLETED",
          repeat: entry.repeat + 1,
          completed: true,
        }
      : { kind: "write", progress: episode, status: "REPEATING", completed: false };
  }
  // Mid-rewatch from a prior session — already opted in (status is REPEATING).
  if (entry.status === "REPEATING") {
    return isFinal
      ? {
          kind: "write",
          progress: total ?? episode,
          status: "COMPLETED",
          repeat: entry.repeat + 1,
          completed: true,
        }
      : {
          kind: "write",
          progress: Math.max(entry.progress, episode),
          status: "REPEATING",
          completed: false,
        };
  }
  // First watch (not on list / planning / paused / dropped / currently watching).
  return {
    kind: "write",
    progress: Math.max(entry.progress, episode),
    status: isFinal ? "COMPLETED" : "CURRENT",
    completed: isFinal,
  };
}

/**
 * The plan for an explicit rewatch confirmation of a COMPLETED entry. `watched`
 * says this episode already played past the threshold: then it counts now.
 * Otherwise the rewatch starts at the episode before it, and the episode counts at
 * its own stop. Pure.
 */
export function planRewatchConfirm(input: {
  episode: number | undefined;
  total: number | null;
  entry: CourEntry | null;
  watched: boolean;
}): CourPlan {
  return planCourWrite({
    phase: "stop",
    progress: input.watched ? 100 : 0,
    watchedThreshold: 1,
    episode: input.episode,
    total: input.total,
    entry: input.entry,
    rewatchConfirmed: true,
  });
}
