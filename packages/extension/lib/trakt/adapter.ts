import type { ParsedMedia } from "@tmsync/shared";
import type { TrackerAdapter } from "../tracker/adapter";
import type {
  RatingLevel,
  RecordPhase,
  RecordResult,
  TrackedItem,
  WatchedEpisode,
  WatchedState,
} from "../tracker/types";
import { isConnected } from "./auth";
import {
  TraktNotConnectedError,
  scrobble,
  resolve as traktResolve,
  watchedProgress,
} from "./client";
import type { ResolvedIdentity } from "./types";
import { buildScrobbleBody } from "./util";

/** Rebuild the Trakt-internal identity from a seam-level item (same fields). */
function toIdentity(item: Extract<TrackedItem, { tracker: "trakt" }>): ResolvedIdentity {
  return { mediaType: item.mediaType, traktId: item.id, title: item.title, year: item.year };
}

/**
 * Trakt behind the seam. This is a thin wrapper over the existing `lib/trakt`
 * client — the real-time scrobble logic, the <1% pause skip, and the 409/HTTP
 * handling are unchanged, just relocated from the background's scrobble handler.
 * Trakt still owns the ≥80% watched decision on `stop`.
 */
export const traktAdapter: TrackerAdapter = {
  tracker: "trakt",

  isConnected,

  async resolve(media: ParsedMedia): Promise<TrackedItem | null> {
    const identity = await traktResolve(media);
    if (!identity) return null;
    return {
      tracker: "trakt",
      mediaType: identity.mediaType,
      id: identity.traktId,
      title: identity.title,
      year: identity.year,
    };
  },

  async recordProgress(
    item: TrackedItem,
    media: ParsedMedia,
    progress: number,
    phase: RecordPhase,
    _watchedThreshold: number,
  ): Promise<RecordResult> {
    if (item.tracker !== "trakt") return { ok: false, reason: "unresolved" };
    const body = buildScrobbleBody(toIdentity(item), media, progress);
    // A show missing season/episode — can't scrobble an episode without both.
    if (!body) return { ok: false, reason: "no_episode" };
    // Trakt rejects a pause under 1% ("progress should be at least 1.0% to
    // pause"); pausing that early has nothing meaningful to save — skip it.
    if (phase === "pause" && body.progress < 1) return { ok: true };
    try {
      const outcome = await scrobble(phase, body);
      return {
        ok: outcome.ok,
        status: outcome.status,
        action: outcome.action,
        reason: outcome.ok ? undefined : "http",
        httpError: outcome.error,
      };
    } catch (e) {
      if (e instanceof TraktNotConnectedError) return { ok: false, reason: "not_connected" };
      throw e;
    }
  },

  ratingLevels(media: ParsedMedia): RatingLevel[] {
    const isShow = media.season !== undefined || media.episode !== undefined;
    return isShow ? ["episode", "season", "show"] : ["movie"];
  },

  async watchedState(item: TrackedItem): Promise<WatchedState | null> {
    // Movies have no episode progress; the show endpoint only applies to shows.
    if (item.tracker !== "trakt" || item.mediaType !== "show") return null;
    let prog: Awaited<ReturnType<typeof watchedProgress>>;
    try {
      prog = await watchedProgress(item.id);
    } catch (e) {
      if (e instanceof TraktNotConnectedError) return null;
      throw e;
    }
    if (!prog) return null;
    // Trakt keeps a true per-episode set — derive "last watched" by the most recent
    // timestamp (NOT the highest number; a rewatch of an earlier episode counts).
    let last: { ref: WatchedEpisode; at: number } | null = null;
    for (const s of prog.seasons) {
      for (const ep of s.episodes) {
        if (!ep.completed || !ep.last_watched_at) continue;
        const at = Date.parse(ep.last_watched_at);
        if (!last || at > last.at) last = { ref: { season: s.number, number: ep.number }, at };
      }
    }
    const next = prog.next_episode
      ? { season: prog.next_episode.season, number: prog.next_episode.number }
      : null;
    const lastWatched = last?.ref ?? null;
    // A gap exists when the next-to-watch episode sits before the last one watched.
    const hasGaps = next !== null && lastWatched !== null && isBefore(next, lastWatched);
    return {
      tracker: "trakt",
      total: prog.aired ?? null,
      watchedCount: prog.completed,
      lastWatched,
      next,
      hasGaps,
    };
  },
};

/** True if episode `a` comes strictly before `b` in (season, number) order. */
function isBefore(a: WatchedEpisode, b: WatchedEpisode): boolean {
  const as = a.season ?? 0;
  const bs = b.season ?? 0;
  return as !== bs ? as < bs : a.number < b.number;
}
