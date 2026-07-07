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
 * User corrections — a LOCAL override layer that sits ABOVE the Fribb crosswalk
 * (docs/MULTI-TRACK.md): precedence is local override › Fribb › miss. Fixes wrong
 * maps, fills misses (real anime Fribb lacks), and pins ambiguous ones. Contributable.
 */
export interface AnimapOverrides {
  /** Forward (TMDB-native → AniList), keyed `${tmdbId}:${season ?? ""}`. A number
   * pins the AniList entry (local episode = tmdb episode, offset 0); `null` means
   * "explicitly NOT on AniList" (skip — e.g. a non-anime show enabled for AniList). */
  forward: Record<string, number | null>;
  /** Reverse (AniList-native → Trakt): AniList id → TMDB target. */
  reverse: Record<number, { tmdbId: number; season: number | null }>;
}

export const EMPTY_OVERRIDES: AnimapOverrides = { forward: {}, reverse: {} };

/** Forward override key for a TMDB show (+ season). */
export function forwardKey(tmdbId: number, season: number | undefined): string {
  return `${tmdbId}:${season ?? ""}`;
}

/**
 * Transform a natively-resolved item into the DERIVED tracker's numbering via the
 * anime-map crosswalk. Pure. Handles both series AND anime movies — a movie is a
 * single-entry (1-episode) cour on AniList, so a non-anime movie simply misses the
 * crosswalk and stays native-only (no is-anime classifier needed).
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
  nativeItem: TrackedItem | null,
  animap: Animap = defaultAnimap,
): DeriveOutcome {
  if (target === "anilist") {
    // TMDB-native → AniList (forward). Needs the scraped TMDB id.
    if (media.tmdbId === undefined) return { kind: "miss" };
    const kind = media.mediaType === "movie" ? "movie" : "tv";
    const r = animap.forward(media.tmdbId, kind, media.season, media.episode);
    if (r.kind !== "resolved") return r;
    // An anime movie is one entry with a single episode on AniList → progress 1 marks
    // it COMPLETED; a series carries its local cour episode. AniList is linear (no
    // season).
    const episode = kind === "movie" ? 1 : r.value.localEpisode;
    return {
      kind: "resolved",
      anilistId: r.value.anilistId,
      media: { ...media, mediaType: "show", season: undefined, episode },
    };
  }

  // target "trakt": AniList-native → Trakt (reverse). Needs a resolved AniList id
  // to bridge — null when we couldn't get one (skip cleanly).
  if (nativeItem?.tracker !== "anilist") return { kind: "miss" };
  const r = animap.reverse(nativeItem.id, media.episode);
  if (r.kind !== "resolved") return r;
  const { tmdbId, tmdbKind, tmdbSeason, tmdbEpisode } = r.value;
  return {
    kind: "resolved",
    media:
      tmdbKind === "movie"
        ? { ...media, mediaType: "movie", tmdbId, season: undefined, episode: undefined }
        : {
            ...media,
            mediaType: "show",
            tmdbId,
            season: tmdbSeason ?? undefined,
            episode: tmdbEpisode,
          },
  };
}

/**
 * Like {@link deriveMedia} but consults the user's local overrides FIRST (local
 * correction › Fribb › miss). A forward override pins/blocks the AniList entry; a
 * reverse override pins the TMDB target. Overrides assume offset 0 (a season = a
 * cour), the common correction case; otherwise it falls through to Fribb.
 */
export function deriveMediaWith(
  target: Tracker,
  media: ParsedMedia,
  nativeItem: TrackedItem | null,
  overrides: AnimapOverrides,
  animap: Animap = defaultAnimap,
): DeriveOutcome {
  if (target === "anilist") {
    if (media.tmdbId !== undefined) {
      const key = forwardKey(media.tmdbId, media.season);
      if (key in overrides.forward) {
        const anilistId = overrides.forward[key];
        if (anilistId == null) return { kind: "miss" }; // explicitly "not on AniList"
        // A pinned movie writes progress 1 (single-episode cour); a series keeps its ep.
        const episode = media.mediaType === "movie" ? 1 : media.episode;
        return {
          kind: "resolved",
          anilistId,
          media: { ...media, mediaType: "show", season: undefined, episode },
        };
      }
    }
    return deriveMedia(target, media, nativeItem, animap);
  }

  // target "trakt": reverse — a pinned TMDB target for this AniList entry.
  if (nativeItem?.tracker === "anilist") {
    const r = overrides.reverse[nativeItem.id];
    if (r) {
      return {
        kind: "resolved",
        media: {
          ...media,
          mediaType: "show",
          tmdbId: r.tmdbId,
          season: r.season ?? undefined,
          episode: media.episode,
        },
      };
    }
  }
  return deriveMedia(target, media, nativeItem, animap);
}
