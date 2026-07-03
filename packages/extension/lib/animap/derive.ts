import type { ParsedMedia } from "@tmsync/shared";
import type { TrackedItem, Tracker } from "../tracker/types";
import { type Animap, defaultAnimap } from "./index";

/**
 * The result of deriving a DERIVED tracker's media coordinates from a natively-
 * resolved item (multi-track — docs/MULTI-TRACK.md). Never a silent guess.
 */
export type DeriveOutcome =
  | { kind: "resolved"; media: ParsedMedia; anilistId?: number }
  | { kind: "miss" } // not in the crosswalk → skip this tracker (native-only)
  | { kind: "ambiguous" }; // can't pin a single cour → refuse + warn

/**
 * Transform a natively-resolved item into the DERIVED tracker's numbering via the
 * anime-map crosswalk. Pure. SERIES only for now — anime-movie dual-track is a
 * follow-up (AniList movie writes need their own path), so movies skip cleanly.
 *
 *  - target "anilist": from a TMDB-native item (uses scraped `media.tmdbId`) → forward
 *  - target "trakt":   from an AniList-native item (uses `nativeItem.id`)     → reverse
 *
 * On `resolved`, returns a ParsedMedia carrying the DERIVED tracker's episode
 * numbering (+ the AniList id for a direct id resolve), ready to hand to that
 * adapter's resolve/record.
 */
export function deriveMedia(
  target: Tracker,
  media: ParsedMedia,
  nativeItem: TrackedItem,
  animap: Animap = defaultAnimap,
): DeriveOutcome {
  // Movies deferred — skip cleanly (native tracker still records them).
  if (media.mediaType === "movie") return { kind: "miss" };

  if (target === "anilist") {
    // TMDB-native → AniList (forward). Needs the scraped TMDB id.
    if (media.tmdbId === undefined) return { kind: "miss" };
    const r = animap.forward(media.tmdbId, "tv", media.season, media.episode);
    if (r.kind !== "resolved") return r;
    return {
      kind: "resolved",
      anilistId: r.value.anilistId,
      // AniList is linear (no season); write the local cour episode.
      media: { ...media, mediaType: "show", season: undefined, episode: r.value.localEpisode },
    };
  }

  // target "trakt": AniList-native → Trakt (reverse). Needs the resolved AniList id.
  if (nativeItem.tracker !== "anilist") return { kind: "miss" };
  const r = animap.reverse(nativeItem.id, media.episode);
  if (r.kind !== "resolved") return r;
  const { tmdbId, tmdbSeason, tmdbEpisode } = r.value;
  return {
    kind: "resolved",
    media: {
      ...media,
      mediaType: "show",
      tmdbId,
      season: tmdbSeason ?? undefined,
      episode: tmdbEpisode,
    },
  };
}
