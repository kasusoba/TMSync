import type { ParsedMedia } from "@tmsync/shared";
import { errorMessage } from "../errors";
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
  SimklNotConnectedError,
  getMatch,
  matchUrl,
  saveMatch,
  scrobble,
  scrobbleBody,
  scrobbleLockWait,
} from "./client";

type SimklItem = Extract<TrackedItem, { tracker: "simkl" }>;

/**
 * Simkl behind the seam. The Trakt paradigm: real-time scrobble start / pause /
 * stop, and Simkl owns the watched decision (stop at 80% or more). It takes either
 * numbering family and maps it server-side, so it gets the page's own numbering
 * (the `any` family: never the crosswalk).
 *
 * Simkl forbids a search before a write: every write matches the item from ids +
 * title + year. So `resolve` makes no network call. It builds the item from the
 * page, with Simkl's own id and title once a write has told us them.
 */
export const simklAdapter: TrackerAdapter = {
  tracker: "simkl",

  // Every namespace Simkl matches on. It is still native only when it stands alone
  // (inferNativeTracker skips passthrough trackers while an anchor exists).
  resolvableNamespaces: ["tmdb", "imdb", "tvdb", "mal", "anilist"],

  isConnected,

  async resolve(media: ParsedMedia): Promise<TrackedItem | null> {
    if (!media.title && !media.ids) return null;
    const match = await getMatch(media);
    const item: SimklItem = {
      tracker: "simkl",
      mediaType: media.mediaType,
      id: match?.id ?? 0,
      title: match?.title || media.title,
      year: match?.year ?? media.year,
      url: match ? matchUrl(match) : undefined,
    };
    return item;
  },

  async recordProgress(
    item: TrackedItem,
    media: ParsedMedia,
    progress: number,
    phase: RecordPhase,
    _watchedThreshold: number,
  ): Promise<RecordResult> {
    if (item.tracker !== "simkl") return { ok: false, reason: "unresolved" };
    if (!(await isConnected())) return { ok: false, reason: "not_connected" };
    const body = scrobbleBody(media, progress, item.id || undefined);
    if (!body) return { ok: false, reason: "no_episode" };
    let out: Awaited<ReturnType<typeof scrobble>>;
    try {
      out = await scrobble(phase, body);
    } catch (e) {
      if (e instanceof SimklNotConnectedError) return { ok: false, reason: "not_connected" };
      return { ok: false, reason: "http", httpError: errorMessage(e) };
    }
    switch (out.kind) {
      case "skipped":
        return { ok: true };
      case "already_recorded":
        return { ok: true, action: "scrobble" };
      case "not_found":
        return { ok: false, reason: "unresolved", httpError: "not found on Simkl" };
      case "failed":
        return {
          ok: false,
          reason: "http",
          status: out.status,
          httpError:
            out.status === 429
              ? "Simkl's daily request limit is used up (it resets at midnight New York time)"
              : `Simkl ${out.status}${out.error ? `: ${out.error}` : ""}`,
        };
      case "ok": {
        if (out.match) await saveMatch(media, out.match);
        const action = out.action === "checkin" ? "start" : out.action;
        return { ok: true, action };
      }
    }
  },

  // A stop inside the 20 s lock waits for it (see `scrobble`).
  stopDelayMs: scrobbleLockWait,

  ratingLevels(media: ParsedMedia): RatingLevel[] {
    // The whole entry only: Simkl has no season or episode ratings.
    return media.mediaType === "movie" ? ["movie"] : ["show"];
  },

  // Reading progress back costs quota (a daily allowance shared with the user's
  // other apps), so the "last watched / next up" line skips Simkl.
  async watchedState(_item: TrackedItem): Promise<WatchedState | null> {
    return null;
  },
};
