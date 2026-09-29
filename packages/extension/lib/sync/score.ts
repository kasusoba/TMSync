import type { ScoreFormat } from "../trackers/types";

/**
 * The scale a tracker stores a score on. `ten` = a whole number from 1 to 10
 * (Trakt, MAL, Simkl). AniList uses the format the user picked.
 */
export type ScoreScale = "ten" | ScoreFormat;

/**
 * A 0 to 100 score as the target scale would store it, given back on the 0 to 100
 * scale so two scores can be compared. Pure.
 *
 * Two scores are "the same" for a target when this gives the same value for both.
 * That check is what stops a rounding loop: AniList 85 fills MAL with 9, and MAL 9
 * is then already equal to AniList 85 on MAL's scale, so nothing is written back.
 */
export function onScale(score: number, scale: ScoreScale): number {
  const s = Math.min(100, Math.max(0, score));
  switch (scale) {
    case "POINT_100":
    case "POINT_10_DECIMAL":
      return Math.max(1, Math.round(s));
    case "POINT_5":
      return Math.min(5, Math.max(1, Math.round(s / 20))) * 20;
    case "POINT_3":
      // AniList's own buckets for the smiley scale.
      return s <= 35 ? 35 : s <= 60 ? 60 : 85;
    default:
      return Math.min(10, Math.max(1, Math.round(s / 10))) * 10;
  }
}

/** A 0 to 100 score as the "8.5" of "8.5/10", for the preview. Pure. */
export function outOfTen(score: number): number {
  return Math.round(score) / 10;
}
