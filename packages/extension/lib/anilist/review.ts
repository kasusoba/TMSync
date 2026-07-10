import type { ParsedMedia } from "@tmsync/shared";
import { anilistNotes, anilistRatings } from "../storage";
import {
  AniListNotConnectedError,
  resolve as anilistResolve,
  saveNotes as anilistSaveNotes,
  saveRating as anilistSaveRating,
} from "./client";

/**
 * AniList rating + private note, co-located with the AniList adapter (was inlined
 * in the background). AniList rates the COUR ENTRY only — score + private notes
 * both write through SaveMediaListEntry, keyed by Media id (no per-episode score,
 * no spoiler flag, no word minimum). Stars are 1–10 in the UI; we store a
 * format-agnostic scoreRaw (0–100) and mirror it locally for instant display.
 */

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function anilistGetReview(
  media: ParsedMedia,
): Promise<{ rating: number | null; note: { text: string; spoiler: boolean } | null }> {
  try {
    const identity = await anilistResolve(media);
    if (!identity) return { rating: null, note: null };
    const scoreRaw = (await anilistRatings.getValue())[identity.id];
    const noteText = (await anilistNotes.getValue())[identity.id];
    return {
      rating: scoreRaw === undefined ? null : Math.round(scoreRaw / 10),
      note: noteText ? { text: noteText, spoiler: false } : null,
    };
  } catch {
    return { rating: null, note: null };
  }
}

export async function anilistRate(
  media: ParsedMedia,
  rating: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const identity = await anilistResolve(media);
    if (!identity) return { ok: false, error: "not found on AniList" };
    const scoreRaw = Math.max(0, Math.min(100, Math.round(rating * 10)));
    const out = await anilistSaveRating(identity.id, scoreRaw);
    if (!out.ok) return { ok: false, error: out.error ?? "rating failed" };
    const all = await anilistRatings.getValue();
    all[identity.id] = scoreRaw;
    await anilistRatings.setValue(all);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof AniListNotConnectedError ? "Not connected to AniList" : errMsg(e),
    };
  }
}

export async function anilistUnrate(media: ParsedMedia): Promise<{ ok: boolean; error?: string }> {
  try {
    const identity = await anilistResolve(media);
    if (!identity) return { ok: false, error: "not found on AniList" };
    const out = await anilistSaveRating(identity.id, 0);
    if (!out.ok) return { ok: false, error: out.error ?? "failed" };
    const all = await anilistRatings.getValue();
    delete all[identity.id];
    await anilistRatings.setValue(all);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof AniListNotConnectedError ? "Not connected to AniList" : errMsg(e),
    };
  }
}

export async function anilistSaveNote(
  media: ParsedMedia,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Note is empty" };
    const identity = await anilistResolve(media);
    if (!identity) return { ok: false, error: "not found on AniList" };
    const out = await anilistSaveNotes(identity.id, trimmed);
    if (!out.ok) return { ok: false, error: out.error ?? "note failed" };
    const all = await anilistNotes.getValue();
    all[identity.id] = trimmed;
    await anilistNotes.setValue(all);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof AniListNotConnectedError ? "Not connected to AniList" : errMsg(e),
    };
  }
}

export async function anilistDeleteNote(
  media: ParsedMedia,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const identity = await anilistResolve(media);
    if (!identity) return { ok: false, error: "not found on AniList" };
    const out = await anilistSaveNotes(identity.id, "");
    if (!out.ok) return { ok: false, error: out.error ?? "failed" };
    const all = await anilistNotes.getValue();
    delete all[identity.id];
    await anilistNotes.setValue(all);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof AniListNotConnectedError ? "Not connected to AniList" : errMsg(e),
    };
  }
}
