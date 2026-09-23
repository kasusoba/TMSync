import type { ParsedMedia } from "@tmsync/shared";
import { errorMessage } from "../errors";
import { malNotes, malRatings } from "../storage";
import { getMyListStatus, resolve as malResolve, updateListStatus } from "./client";

/**
 * MyAnimeList rating + private note. MAL scores the entry (the cour) 1 to 10, the
 * same scale as the UI stars, and keeps a private `comments` note on it. Both
 * write through the list-status PATCH. No per-episode score, no spoiler flag, no
 * public text. Read from MAL itself, so a score or note set on the MAL site shows
 * (and can be removed) here. The local mirror is the fallback when MAL can't be read.
 */

type Ok = { ok: boolean; error?: string };

/** Resolve the entry, run a write, and keep the local mirror in step. */
async function withEntry(
  media: ParsedMedia,
  write: (id: number) => Promise<Ok>,
  mirror: (id: number) => Promise<void>,
): Promise<Ok> {
  try {
    const identity = await malResolve(media);
    if (!identity) return { ok: false, error: "not found on MyAnimeList" };
    const out = await write(identity.id);
    if (!out.ok) return { ok: false, error: out.error ?? "failed" };
    await mirror(identity.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function malGetReview(
  media: ParsedMedia,
): Promise<{ rating: number | null; note: { text: string; spoiler: boolean } | null }> {
  try {
    const identity = await malResolve(media);
    if (!identity) return { rating: null, note: null };
    let score: number | undefined;
    let noteText: string | undefined;
    try {
      const status = await getMyListStatus(identity.id);
      score = status?.score || undefined; // 0 = no score
      noteText = status?.comments || undefined;
    } catch {
      score = (await malRatings.getValue())[identity.id];
      noteText = (await malNotes.getValue())[identity.id];
    }
    return {
      rating: score ?? null,
      note: noteText ? { text: noteText, spoiler: false } : null,
    };
  } catch {
    return { rating: null, note: null };
  }
}

export function malRate(media: ParsedMedia, rating: number): Promise<Ok> {
  const score = Math.max(1, Math.min(10, Math.round(rating)));
  return withEntry(
    media,
    (id) => updateListStatus(id, { score }),
    async (id) => {
      const all = await malRatings.getValue();
      all[id] = score;
      await malRatings.setValue(all);
    },
  );
}

export function malUnrate(media: ParsedMedia): Promise<Ok> {
  return withEntry(
    media,
    (id) => updateListStatus(id, { score: 0 }),
    async (id) => {
      const all = await malRatings.getValue();
      delete all[id];
      await malRatings.setValue(all);
    },
  );
}

export async function malSaveNote(media: ParsedMedia, text: string): Promise<Ok> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Note is empty" };
  return withEntry(
    media,
    (id) => updateListStatus(id, { comments: trimmed }),
    async (id) => {
      const all = await malNotes.getValue();
      all[id] = trimmed;
      await malNotes.setValue(all);
    },
  );
}

export function malDeleteNote(media: ParsedMedia): Promise<Ok> {
  return withEntry(
    media,
    (id) => updateListStatus(id, { comments: "" }),
    async (id) => {
      const all = await malNotes.getValue();
      delete all[id];
      await malNotes.setValue(all);
    },
  );
}
