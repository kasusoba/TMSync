import type { ParsedMedia } from "@tmsync/shared";
import { notes, ratings, remoteRatings } from "../storage";
import {
  commentItem,
  deleteComment,
  getRemoteRating,
  postComment,
  rate,
  resolve,
  updateComment,
} from "./client";
import type { ReviewLevel } from "./types";
import { buildRatingBody, reviewKey } from "./util";

/**
 * Trakt rating + note (a note is a managed Trakt comment), co-located with the
 * Trakt adapter (was inlined in the background's message handlers). Trakt rates
 * per level (movie / show / season / episode), scores 1–10, and requires a
 * ≥5-word comment. Ratings set on the Trakt website are synced back on read.
 */

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export async function traktGetReview(
  media: ParsedMedia,
  level: ReviewLevel,
): Promise<{
  rating: number | null;
  note: { text: string; spoiler: boolean } | null;
}> {
  try {
    const identity = await resolve(media);
    if (!identity) return { rating: null, note: null };
    const key = reviewKey(identity, level, media.season, media.episode);
    const localRating = (await ratings.getValue())[key] ?? null;
    // Prefer a recent local action; otherwise sync the rating from Trakt so
    // ratings set on the website show up too. Mirror the remote value locally.
    let rating = localRating;
    if (localRating === null) {
      try {
        const remote = await getRemoteRating(identity, level, media.season, media.episode);
        if (remote !== null) {
          rating = remote;
          const all = await ratings.getValue();
          all[key] = remote;
          await ratings.setValue(all);
        }
      } catch {
        // not connected / network — fall back to local (null)
      }
    }
    const stored = (await notes.getValue())[key];
    return { rating, note: stored ? { text: stored.text, spoiler: stored.spoiler } : null };
  } catch {
    return { rating: null, note: null };
  }
}

export async function traktRate(
  media: ParsedMedia,
  level: ReviewLevel,
  rating: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const identity = await resolve(media);
    if (!identity) return { ok: false, error: "not found on Trakt" };
    const body = buildRatingBody(identity, level, media.season, media.episode, rating);
    if (!body) return { ok: false, error: "missing season/episode" };
    const out = await rate(body);
    if (!out.ok) return { ok: false, error: out.error ?? `failed (${out.status})` };
    const key = reviewKey(identity, level, media.season, media.episode);
    const all = await ratings.getValue();
    all[key] = rating;
    await ratings.setValue(all);
    await remoteRatings.setValue({}); // invalidate the sync cache
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function traktUnrate(
  media: ParsedMedia,
  level: ReviewLevel,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const identity = await resolve(media);
    if (!identity) return { ok: false, error: "not found on Trakt" };
    const body = buildRatingBody(identity, level, media.season, media.episode);
    if (!body) return { ok: false, error: "missing season/episode" };
    const out = await rate(body, true);
    if (!out.ok) return { ok: false, error: out.error ?? `failed (${out.status})` };
    const key = reviewKey(identity, level, media.season, media.episode);
    const all = await ratings.getValue();
    delete all[key];
    await ratings.setValue(all);
    await remoteRatings.setValue({}); // invalidate the sync cache
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function traktSaveNote(
  media: ParsedMedia,
  level: ReviewLevel,
  text: string,
  spoiler: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const trimmed = text.trim();
    if (wordCount(trimmed) < 5)
      return { ok: false, error: "Trakt needs a note of at least 5 words" };
    const identity = await resolve(media);
    if (!identity) return { ok: false, error: "not found on Trakt" };
    const key = reviewKey(identity, level, media.season, media.episode);
    const all = await notes.getValue();
    const existing = all[key];
    if (existing) {
      const out = await updateComment(existing.commentId, trimmed, spoiler);
      if (!out.ok) return { ok: false, error: out.error };
      all[key] = { ...existing, text: trimmed, spoiler };
    } else {
      const ref = await commentItem(identity, level, media.season, media.episode);
      if ("error" in ref) return { ok: false, error: ref.error };
      const out = await postComment(ref.item, trimmed, spoiler);
      if (!out.ok || out.id === undefined)
        return { ok: false, error: out.error ?? "comment failed" };
      all[key] = { commentId: out.id, text: trimmed, spoiler };
    }
    await notes.setValue(all);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function traktDeleteNote(
  media: ParsedMedia,
  level: ReviewLevel,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const identity = await resolve(media);
    if (!identity) return { ok: false, error: "not found on Trakt" };
    const key = reviewKey(identity, level, media.season, media.episode);
    const all = await notes.getValue();
    const existing = all[key];
    if (!existing) return { ok: true };
    const out = await deleteComment(existing.commentId);
    if (!out.ok) return { ok: false, error: out.error };
    delete all[key];
    await notes.setValue(all);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
