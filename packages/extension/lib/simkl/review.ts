import type { ParsedMedia } from "@tmsync/shared";
import { errorMessage } from "../errors";
import { simklRatings } from "../storage";
import { getMatch, simklIds, simklKey, simklKind, simklPost } from "./client";

/**
 * Simkl rating. Simkl rates the whole entry (a movie, a show, an anime) 1 to 10,
 * the same scale as the UI stars. It keeps no notes. Mirrored locally, because
 * reading one rating back from Simkl costs a whole-list call against the user's
 * daily quota.
 */

type Ok = { ok: boolean; error?: string };

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

/**
 * The mirror key for a rating: the Simkl entry it lands on. Once a write has named
 * the entry, its Simkl id (a western show's seasons share one; an anime season is
 * its own entry). Before that, the page item without its season, since Simkl
 * matches the show from the page's ids and rates the whole show.
 */
async function ratingKeys(media: ParsedMedia): Promise<{ key: string; older?: string }> {
  const match = await getMatch(media);
  const show = simklKey(media, false);
  // A rating saved before the first write named the entry sits under the page key.
  return match ? { key: `simkl:${match.id}`, older: show } : { key: show };
}

/** Keep the local mirror in step with a rating write (null = removed). */
async function saveMirror(media: ParsedMedia, score: number | null): Promise<void> {
  const { key, older } = await ratingKeys(media);
  const all = await simklRatings.getValue();
  if (older) delete all[older];
  if (score === null) delete all[key];
  else all[key] = score;
  await simklRatings.setValue(all);
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
  const { key, older } = await ratingKeys(media);
  const all = await simklRatings.getValue();
  const rating = all[key] ?? (older ? all[older] : undefined);
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
    await saveMirror(media, score);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
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
    await saveMirror(media, null);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
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
