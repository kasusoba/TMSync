import type { RecordPhase } from "../tracker/types";
import type { AniListEntry, MediaListStatus } from "./types";

/**
 * The decision for an AniList progress event, computed purely (no I/O) so it can
 * be unit-tested. Unlike Trakt, AniList tracks a per-cour *status* (CURRENT /
 * COMPLETED / REPEATING) plus a progress count and a rewatch count — so we read
 * the viewer's current entry and compute the right transition, never lowering
 * remote progress.
 *
 * Rewatch rule (per the user): a COMPLETED cour is **never silently mutated**.
 * Watching any episode of it yields `needs_rewatch` (a prompt) and writes nothing
 * until the user confirms; only then do we switch to REPEATING and track again.
 */
export type AniListPlan =
  | { kind: "noop" } // start/pause, stop below threshold, or already-counted
  | { kind: "no_episode" } // a show with no scraped episode number
  | { kind: "mismatch"; episode: number; total: number } // numbering guardrail (step 6)
  | { kind: "needs_rewatch"; episode: number } // completed cour, awaiting confirmation
  | {
      kind: "write";
      progress: number;
      status: MediaListStatus;
      repeat?: number;
      /** True when this write finishes the cour (drives the rating prompt). */
      completed: boolean;
    };

export interface AniListPlanInput {
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
  entry: AniListEntry | null;
  /**
   * Whether the user has just confirmed a rewatch of a COMPLETED cour. Normal
   * threshold writes pass false (→ `needs_rewatch`); the explicit confirm passes
   * true (→ writes REPEATING / re-COMPLETED).
   */
  rewatchConfirmed: boolean;
}

const EMPTY: AniListEntry = { status: null, progress: 0, repeat: 0 };

/**
 * Decide what (if anything) to write to AniList for a progress phase, given the
 * viewer's current entry. Only a `stop` at/after `watchedThreshold` counts as
 * watched. Idempotent: never lowers progress within a status, never re-writes an
 * already-counted episode.
 */
export function planAniListWrite(input: AniListPlanInput): AniListPlan {
  const { phase, progress, watchedThreshold, episode, total, rewatchConfirmed } = input;
  const entry = input.entry ?? EMPTY;

  // AniList has nothing to receive start/pause; only a finished stop matters.
  if (phase !== "stop") return { kind: "noop" };
  if (progress < watchedThreshold * 100) return { kind: "noop" };
  if (episode === undefined) return { kind: "no_episode" };
  // Guardrail: a scraped episode beyond the entry's total is a numbering mismatch.
  if (total !== null && episode > total) return { kind: "mismatch", episode, total };

  const isFinal = total !== null && episode >= total;

  // A COMPLETED cour is sacred: never mutate it on a stray replay. Prompt first;
  // write only once the user confirms the rewatch (rewatchConfirmed).
  if (entry.status === "COMPLETED") {
    if (!rewatchConfirmed) return { kind: "needs_rewatch", episode };
    // Confirmed rewatch: REPEATING until the final episode re-completes it (+1 repeat).
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
    if (!isFinal && episode <= entry.progress) return { kind: "noop" };
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
  // Already counted this episode while CURRENT ⇒ nothing to do.
  if (entry.status === "CURRENT" && !isFinal && episode <= entry.progress) {
    return { kind: "noop" };
  }
  return {
    kind: "write",
    progress: Math.max(entry.progress, episode),
    status: isFinal ? "COMPLETED" : "CURRENT",
    completed: isFinal,
  };
}
