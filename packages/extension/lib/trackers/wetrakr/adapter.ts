import type { ParsedMedia } from "@tmsync/shared";
import { browser } from "wxt/browser";
import type { TrackerAdapter } from "../adapter";
import {
  type RatingLevel,
  type RecordPhase,
  type RecordResult,
  type TrackedItem,
  type WatchedState,
  clampProgress,
} from "../types";
import { isConnected } from "./auth";
import {
  WetrakrNotConnectedError,
  cancelPlaying,
  scrobble,
  resolve as wetrakrResolve,
} from "./client";
import type { ScrobbleBody, ScrobbleReply } from "./types";

type WetrakrItem = Extract<TrackedItem, { tracker: "wetrakr" }>;

/**
 * Build a /scrobble body from a resolved title and the scraped media. Null for a
 * show missing its season or episode. Pure.
 */
export function buildScrobbleBody(
  item: WetrakrItem,
  media: ParsedMedia,
  progress: number,
  appVersion: string,
): ScrobbleBody | null {
  const p = clampProgress(progress);
  if (item.mediaType === "movie") {
    return { movie: { id: item.id }, progress: p, app_version: appVersion };
  }
  if (media.season === undefined || media.episode === undefined) return null;
  return {
    show: { id: item.id },
    episode: { season: media.season, number: media.episode },
    progress: p,
    app_version: appVersion,
  };
}

/**
 * The guardrail: WeTrakr echoes the episode it matched. When that is not the episode
 * we sent (absolute numbering against seasonal), name what it matched. Null when it
 * matches, or when the reply names no episode. Pure.
 */
export function episodeMismatch(body: ScrobbleBody, reply: ScrobbleReply): string | null {
  if (!("episode" in body) || !reply.episode) return null;
  const sent = body.episode;
  const got = reply.episode;
  if (got.season_number === sent.season && got.number === sent.number) return null;
  return `WeTrakr matched S${got.season_number}E${got.number}, not S${sent.season}E${sent.number} · this site's numbering doesn't match WeTrakr`;
}

/**
 * WeTrakr behind the seam. The scrobble paradigm, like Trakt: real-time
 * start/pause/stop, and WeTrakr owns the watched decision (80% or more on stop logs
 * the play; a repeat inside one runtime is not logged twice).
 */
export const wetrakrAdapter: TrackerAdapter = {
  tracker: "wetrakr",

  // GET /media/external speaks these directly (strongest first).
  resolvableNamespaces: ["tmdb", "imdb", "tvdb"],

  isConnected,

  async resolve(media: ParsedMedia): Promise<TrackedItem | null> {
    let identity: Awaited<ReturnType<typeof wetrakrResolve>>;
    try {
      identity = await wetrakrResolve(media);
    } catch (e) {
      if (e instanceof WetrakrNotConnectedError) return null;
      throw e;
    }
    if (!identity) return null;
    return { tracker: "wetrakr", ...identity };
  },

  async recordProgress(
    item: TrackedItem,
    media: ParsedMedia,
    progress: number,
    phase: RecordPhase,
  ): Promise<RecordResult> {
    if (item.tracker !== "wetrakr") return { ok: false, reason: "unresolved" };
    const body = buildScrobbleBody(item, media, progress, browser.runtime.getManifest().version);
    if (!body) return { ok: false, reason: "no_episode" };
    try {
      const outcome = await scrobble(phase, body);
      if (!outcome.ok || !outcome.reply) {
        return { ok: false, status: outcome.status, reason: "http", httpError: outcome.error };
      }
      const mismatch = episodeMismatch(body, outcome.reply);
      if (mismatch) {
        // Fail visibly, never log a play on the wrong episode.
        await cancelPlaying(body).catch(() => undefined);
        return {
          ok: false,
          status: outcome.status,
          reason: "numbering_mismatch",
          httpError: mismatch,
        };
      }
      const action = outcome.reply.action;
      return {
        ok: true,
        status: outcome.status,
        action: action === "checkin" ? "start" : action,
      };
    } catch (e) {
      if (e instanceof WetrakrNotConnectedError) return { ok: false, reason: "not_connected" };
      throw e;
    }
  },

  // Rating comes with the review step.
  ratingLevels(_media: ParsedMedia): RatingLevel[] {
    return [];
  },

  async watchedState(_item: TrackedItem): Promise<WatchedState | null> {
    return null;
  },
};
