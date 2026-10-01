import { wetrakrEpisodeChecks } from "@/lib/storage";
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
import { forgetProgress, wetrakrWatchedState } from "./review";
import type { ScrobbleBody, ScrobbleReply } from "./types";

type WetrakrItem = Extract<TrackedItem, { tracker: "wetrakr" }>;

/** How long an episode check holds: a viewing session and its late stop. */
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

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

/** The episode-check key of a show body (null for a movie). Pure. */
export function checkKey(body: ScrobbleBody): string | null {
  if (!("episode" in body)) return null;
  return `${body.show.id}:${body.episode.season}:${body.episode.number}`;
}

/** The saved check of an episode: the mismatch, null when it matched, or
 * undefined when it was not checked recently. */
async function savedCheck(key: string): Promise<string | null | undefined> {
  const hit = (await wetrakrEpisodeChecks.getValue())[key];
  return hit && Date.now() - hit.at < CHECK_TTL_MS ? hit.mismatch : undefined;
}

async function saveCheck(key: string, mismatch: string | null): Promise<void> {
  const now = Date.now();
  const all = await wetrakrEpisodeChecks.getValue();
  const live = Object.fromEntries(Object.entries(all).filter(([, c]) => now - c.at < CHECK_TTL_MS));
  await wetrakrEpisodeChecks.setValue({ ...live, [key]: { at: now, mismatch } });
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
    const key = checkKey(body);
    try {
      // A stop at 80% or more logs the play before WeTrakr shows what it matched,
      // so check the episode first. A start echoes the match and logs nothing.
      if (key && phase === "stop") {
        let known = await savedCheck(key);
        if (known === undefined) {
          const probe = await scrobble("start", body);
          if (probe.ok && probe.reply) {
            known = episodeMismatch(body, probe.reply);
            await saveCheck(key, known);
          }
        }
        if (known) {
          await cancelPlaying(body).catch(() => undefined);
          return { ok: false, reason: "numbering_mismatch", httpError: known };
        }
      }
      const outcome = await scrobble(phase, body);
      if (!outcome.ok || !outcome.reply) {
        return { ok: false, status: outcome.status, reason: "http", httpError: outcome.error };
      }
      const mismatch = episodeMismatch(body, outcome.reply);
      if (key && outcome.reply.episode) await saveCheck(key, mismatch);
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
      // A logged play changes the show's progress: drop the cached copy.
      if (action === "scrobble") await forgetProgress(item.id);
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

  ratingLevels(media: ParsedMedia): RatingLevel[] {
    const isShow = media.season !== undefined || media.episode !== undefined;
    return isShow ? ["episode", "season", "show"] : ["movie"];
  },

  async watchedState(item: TrackedItem): Promise<WatchedState | null> {
    if (item.tracker !== "wetrakr" || item.mediaType !== "show") return null;
    try {
      return await wetrakrWatchedState(item.id);
    } catch (e) {
      if (e instanceof WetrakrNotConnectedError) return null;
      throw e;
    }
  },
};
