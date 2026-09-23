import type { ParsedMedia } from "@tmsync/shared";
import { simklRatings } from "../storage";
import {
  SimklNotConnectedError,
  getMatch,
  simklIds,
  simklKey,
  simklKind,
  simklPost,
} from "./client";

/**
 * Simkl rating. Simkl rates the whole entry (a movie, a show, an anime) 1 to 10,
 * the same scale as the UI stars. It keeps no notes. Mirrored locally, because
 * reading one rating back from Simkl costs a whole-list call against the user's
 * daily quota.
 */

type Ok = { ok: boolean; error?: string };

const errMsg = (e: unknown) =>
  e instanceof SimklNotConnectedError
    ? "Not connected to Simkl"
    : e instanceof Error
      ? e.message
      : String(e);

/** The ratings body item for a page item: Simkl's id when known, else the page's
 * ids + title + year (Simkl matches server-side; never search first). */
async function ratingItem(media: ParsedMedia): Promise<Record<string, unknown>> {
  const match = await getMatch(media);
  return {
    title: media.title,
    ...(media.year ? { year: media.year } : {}),
    ids: simklIds(media, match?.id),
  };
}

/** Whether a ratings response put anything in `not_found`. Simkl answers 201 even
 * when it ignored every item, so the body is the only signal. Pure. */
export function anyNotFound(data: unknown): boolean {
  const nf = (data as { not_found?: Record<string, unknown[]> } | undefined)?.not_found;
  return !!nf && Object.values(nf).some((list) => Array.isArray(list) && list.length > 0);
}

export async function simklGetReview(
  media: ParsedMedia,
): Promise<{ rating: number | null; note: null }> {
  const rating = (await simklRatings.getValue())[simklKey(media)];
  return { rating: rating ?? null, note: null };
}

export async function simklRate(media: ParsedMedia, rating: number): Promise<Ok> {
  const score = Math.max(1, Math.min(10, Math.round(rating)));
  // Anime can go under `anime` when adding (the docs' own example); removing
  // folds it into `shows`.
  const kind = simklKind(media);
  const list = kind === "movie" ? "movies" : kind === "anime" ? "anime" : "shows";
  try {
    const res = await simklPost("/sync/ratings", {
      [list]: [{ ...(await ratingItem(media)), rating: score }],
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `Simkl ${res.status}${res.error ? `: ${res.error}` : ""}` };
    }
    if (anyNotFound(res.data)) return { ok: false, error: "not found on Simkl" };
    const all = await simklRatings.getValue();
    await simklRatings.setValue({ ...all, [simklKey(media)]: score });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function simklUnrate(media: ParsedMedia): Promise<Ok> {
  const key = simklKind(media) === "movie" ? "movies" : "shows";
  try {
    const res = await simklPost("/sync/ratings/remove", { [key]: [await ratingItem(media)] });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `Simkl ${res.status}${res.error ? `: ${res.error}` : ""}` };
    }
    if (anyNotFound(res.data)) return { ok: false, error: "not found on Simkl" };
    const all = await simklRatings.getValue();
    delete all[simklKey(media)];
    await simklRatings.setValue(all);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Simkl keeps no notes. The rating panel never sends one (TRACKER_INFO note:
 * "none"); this answers any caller that still does. */
export async function simklSaveNote(): Promise<Ok> {
  return { ok: false, error: "Simkl has no notes" };
}

export async function simklDeleteNote(): Promise<Ok> {
  return { ok: true };
}
