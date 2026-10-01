import type { ParsedMedia } from "@tmsync/shared";
import { errorMessage } from "../../errors";
import { wetrakrNotes, wetrakrProgress, wetrakrRatings } from "../../storage";
import type { WatchedEpisode, WatchedState } from "../types";
import {
  type ReviewLevel,
  type WetrakrEpisode,
  deleteComment,
  getRemoteRating,
  itemId,
  itemPath,
  postComment,
  ratingBody,
  resolve,
  seasonEpisodes,
  seasonNumbers,
  syncRatings,
} from "./client";
import type { WetrakrIdentity } from "./types";

/**
 * WeTrakr rating and note. It rates per level (movie, show, season, episode) from 0
 * to 10; TMSync sends whole stars, 1 to 10. The note is a public comment, like
 * Trakt's, with a spoiler flag and no minimum length. WeTrakr has no comment edit,
 * so a changed note deletes the old comment and posts a new one.
 */

type Ok = Promise<{ ok: boolean; error?: string }>;

/** Key of a rating or note at one level. Pure. */
export function wetrakrReviewKey(
  identity: WetrakrIdentity,
  level: ReviewLevel,
  season?: number,
  episode?: number,
): string {
  const s = level === "season" || level === "episode" ? (season ?? "") : "";
  const e = level === "episode" ? (episode ?? "") : "";
  return `${level}:${identity.id}:${s}:${e}`;
}

/** The comment target for a level: movie and show by their id, a season or an
 * episode by its own WeTrakr id (one lookup). */
async function commentTarget(
  identity: WetrakrIdentity,
  level: ReviewLevel,
  season?: number,
  episode?: number,
): Promise<Parameters<typeof postComment>[0] | null> {
  if (level === "movie") return { movie: { id: identity.id } };
  if (level === "show") return { show: { id: identity.id } };
  const path = itemPath(identity, level, season, episode);
  const id = path ? await itemId(path) : null;
  if (id === null) return null;
  return level === "season" ? { season: { id } } : { episode: { id } };
}

export async function wetrakrGetReview(
  media: ParsedMedia,
  level: ReviewLevel,
): Promise<{ rating: number | null; note: { text: string; spoiler: boolean } | null }> {
  try {
    const identity = await resolve(media);
    if (!identity) return { rating: null, note: null };
    const key = wetrakrReviewKey(identity, level, media.season, media.episode);
    let rating = (await wetrakrRatings.getValue())[key] ?? null;
    // No local copy: read it from WeTrakr, so a rating made on the site shows too.
    const path = itemPath(identity, level, media.season, media.episode);
    if (rating === null && path) {
      const remote = await getRemoteRating(path).catch(() => null);
      if (remote !== null) {
        rating = Math.max(1, Math.round(remote));
        await wetrakrRatings.setValue({ ...(await wetrakrRatings.getValue()), [key]: rating });
      }
    }
    const note = (await wetrakrNotes.getValue())[key];
    return { rating, note: note ? { text: note.text, spoiler: note.spoiler } : null };
  } catch {
    return { rating: null, note: null };
  }
}

/** Rate (or, with no rating, unrate) one level. */
async function writeRating(media: ParsedMedia, level: ReviewLevel, rating?: number): Ok {
  try {
    const identity = await resolve(media);
    if (!identity) return { ok: false, error: "not found on WeTrakr" };
    const body = ratingBody(identity, level, media.season, media.episode, rating);
    if (!body) return { ok: false, error: "missing season/episode" };
    const out = await syncRatings(body, rating === undefined);
    if (!out.ok) return out;
    const key = wetrakrReviewKey(identity, level, media.season, media.episode);
    const all = await wetrakrRatings.getValue();
    if (rating === undefined) delete all[key];
    else all[key] = rating;
    await wetrakrRatings.setValue(all);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export const wetrakrRate = (media: ParsedMedia, level: ReviewLevel, rating: number): Ok =>
  writeRating(media, level, rating);

export const wetrakrUnrate = (media: ParsedMedia, level: ReviewLevel): Ok =>
  writeRating(media, level);

export async function wetrakrSaveNote(
  media: ParsedMedia,
  level: ReviewLevel,
  text: string,
  spoiler: boolean,
): Ok {
  try {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "The note is empty" };
    const identity = await resolve(media);
    if (!identity) return { ok: false, error: "not found on WeTrakr" };
    const key = wetrakrReviewKey(identity, level, media.season, media.episode);
    const all = await wetrakrNotes.getValue();
    const old = all[key];
    if (old && old.text === trimmed && old.spoiler === spoiler) return { ok: true };
    const target = await commentTarget(identity, level, media.season, media.episode);
    if (!target) return { ok: false, error: "not found on WeTrakr" };
    // Post first, then delete the old one: a failed post keeps the old comment.
    const out = await postComment(target, trimmed, spoiler);
    if (!out.ok || out.id === undefined) return { ok: false, error: out.error ?? "comment failed" };
    if (old) await deleteComment(old.commentId);
    all[key] = { commentId: out.id, text: trimmed, spoiler };
    await wetrakrNotes.setValue(all);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function wetrakrDeleteNote(media: ParsedMedia, level: ReviewLevel): Ok {
  try {
    const identity = await resolve(media);
    if (!identity) return { ok: false, error: "not found on WeTrakr" };
    const key = wetrakrReviewKey(identity, level, media.season, media.episode);
    const all = await wetrakrNotes.getValue();
    const old = all[key];
    if (!old) return { ok: true };
    const out = await deleteComment(old.commentId);
    if (!out.ok) return out;
    delete all[key];
    await wetrakrNotes.setValue(all);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

// --- watched progress (the popup's "last watched / next up" line) ---

/** How long a show's progress is kept. */
const PROGRESS_TTL_MS = 5 * 60 * 1000;

/** Above this many seasons, reading progress costs too many calls, so none shows. */
const MAX_SEASONS = 15;

/**
 * Reduce a show's episodes (with the user's tracking state) to a WatchedState:
 * the aired count, the watched count, the most recent watch by time, and the first
 * aired episode not watched. Pure.
 */
export function progressFrom(
  seasons: { season: number; episodes: WetrakrEpisode[] }[],
  now = Date.now(),
): WatchedState {
  let total = 0;
  let watched = 0;
  let last: { ref: WatchedEpisode; at: number } | null = null;
  let next: WatchedEpisode | null = null;
  for (const { season, episodes } of seasons) {
    for (const ep of [...episodes].sort((a, b) => a.number - b.number)) {
      const aired = !!ep.air_date && Date.parse(ep.air_date) <= now;
      const track = ep.interactions?.user?.tracking?.last;
      const seen = track?.status === "watched";
      if (seen) {
        watched++;
        const at = track?.last_watched_at ? Date.parse(track.last_watched_at) : 0;
        if (!last || at > last.at) last = { ref: { season, number: ep.number }, at };
      }
      if (aired) total++;
      if (aired && !seen && !next) next = { season, number: ep.number };
    }
  }
  const lastWatched = last?.ref ?? null;
  const before = (a: WatchedEpisode, b: WatchedEpisode) =>
    (a.season ?? 0) !== (b.season ?? 0) ? (a.season ?? 0) < (b.season ?? 0) : a.number < b.number;
  return {
    tracker: "wetrakr",
    total,
    watchedCount: watched,
    lastWatched,
    next,
    hasGaps: next !== null && lastWatched !== null && before(next, lastWatched),
  };
}

/** Drop a show's cached progress (after a logged play). */
export async function forgetProgress(showId: number): Promise<void> {
  const cache = await wetrakrProgress.getValue();
  if (!(showId in cache)) return;
  delete cache[showId];
  await wetrakrProgress.setValue(cache);
}

/** The viewer's progress on a show (cached a few minutes). Null when unknown. */
export async function wetrakrWatchedState(showId: number): Promise<WatchedState | null> {
  const cache = await wetrakrProgress.getValue();
  const hit = cache[showId];
  if (hit && Date.now() - hit.at < PROGRESS_TTL_MS) return hit.state;
  const numbers = await seasonNumbers(showId);
  let state: WatchedState | null = null;
  if (numbers && numbers.length <= MAX_SEASONS) {
    const seasons = await Promise.all(
      numbers.map(async (season) => ({ season, episodes: await seasonEpisodes(showId, season) })),
    );
    state = progressFrom(seasons);
  }
  await wetrakrProgress.setValue({ ...cache, [showId]: { at: Date.now(), state } });
  return state;
}
