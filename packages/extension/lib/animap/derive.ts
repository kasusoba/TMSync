import type { ParsedMedia } from "@tmsync/shared";
import {
  type ExternalIds,
  TRACKER_INFO,
  type TrackedItem,
  type Tracker,
  trackerFamily,
} from "../tracker/types";
import type { Animap } from "./index";

/** Exact ids of the derived tracker's entry, from the crosswalk or a user pin. The
 * background resolves by these directly (no title search, which could pick the
 * wrong cour). */
export type TargetIds = ExternalIds;

/**
 * The result of deriving a DERIVED tracker's media coordinates from a natively-
 * resolved item (multi-track, docs/MULTI-TRACK.md). Never a silent guess.
 */
export type DeriveOutcome =
  | { kind: "resolved"; media: ParsedMedia; ids?: TargetIds }
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
  /** Forward (TMDB-native → MAL), same key as `forward`. Pins (or blocks, `null`) the
   * MAL entry on its own, above the AniList pin that MAL otherwise follows. Optional:
   * values stored before MAL existed lack it. */
  forwardMal?: Record<string, number | null>;
  /** Reverse (AniList-native → Trakt): AniList id → TMDB target. */
  reverse: Record<number, { tmdbId: number; season: number | null }>;
}

export const EMPTY_OVERRIDES: AnimapOverrides = { forward: {}, reverse: {} };

/** Forward override key for a TMDB show (+ season). */
export function forwardKey(tmdbId: number, season: number | undefined): string {
  return `${tmdbId}:${season ?? ""}`;
}

/**
 * Transform a natively-resolved item into the DERIVED tracker's numbering. Pure.
 * Trackers are grouped by numbering FAMILY (`TRACKER_INFO.family`):
 *
 *  - same family as the native item: the numbering already matches, so only the
 *    ids carry over (AniList ⇄ MAL are 1:1). No crosswalk.
 *  - target in `cour` (AniList, MAL): forward crosswalk, from the scraped `media.ids.tmdb`
 *  - target in `seasoned` (Trakt):    reverse crosswalk, from the cour-native item's id
 *
 * Handles series AND anime movies. A movie is a single-entry (1-episode) cour on
 * the cour side, so a non-anime movie simply misses the crosswalk and stays
 * native-only (no is-anime classifier needed).
 *
 * On `resolved`, returns a ParsedMedia in the derived tracker's numbering, plus the
 * exact target ids when the crosswalk names the entry, ready for that adapter.
 */
export function deriveMedia(
  target: Tracker,
  media: ParsedMedia,
  nativeItem: TrackedItem | null,
  animap: Animap,
): DeriveOutcome {
  const family = trackerFamily(target);
  if (nativeItem && trackerFamily(nativeItem.tracker) === family) {
    return sameFamily(media, nativeItem);
  }
  return family === "cour" ? toCour(media, animap) : toSeasoned(media, nativeItem, animap);
}

/** Same numbering family: keep the media as is and pass every id the native item
 * is known by, so the target resolves its own entry exactly. */
function sameFamily(media: ParsedMedia, nativeItem: TrackedItem): DeriveOutcome {
  const ids: TargetIds = "ids" in nativeItem ? { ...nativeItem.ids } : {};
  const own = TRACKER_INFO[nativeItem.tracker].ownNamespace;
  if (own) ids[own] = nativeItem.id;
  return Object.keys(ids).length ? { kind: "resolved", media, ids } : { kind: "miss" };
}

/** Seasoned → cour (forward). Needs the scraped TMDB id. */
function toCour(media: ParsedMedia, animap: Animap): DeriveOutcome {
  const tmdbId = media.ids?.tmdb;
  if (tmdbId === undefined) return { kind: "miss" };
  const kind = media.mediaType === "movie" ? "movie" : "tv";
  const r = animap.forward(Number(tmdbId), kind, media.season, media.episode);
  if (r.kind !== "resolved") return r;
  // An anime movie is one entry with a single episode on the cour side → progress 1
  // marks it COMPLETED; a series carries its local cour episode. Cour numbering is
  // linear (no season).
  const episode = kind === "movie" ? 1 : r.value.localEpisode;
  const ids: TargetIds = { anilist: r.value.anilistId };
  if (r.value.malId !== undefined) ids.mal = r.value.malId;
  return {
    kind: "resolved",
    ids,
    media: { ...media, mediaType: "show", season: undefined, episode },
  };
}

/** Cour → seasoned (reverse). Needs a resolved cour-native item to bridge from;
 * null when we couldn't get one (skip cleanly). */
function toSeasoned(
  media: ParsedMedia,
  nativeItem: TrackedItem | null,
  animap: Animap,
): DeriveOutcome {
  const ns = nativeItem ? TRACKER_INFO[nativeItem.tracker].ownNamespace : undefined;
  if (!nativeItem || (ns !== "anilist" && ns !== "mal")) return { kind: "miss" };
  const r = animap.reverse(ns, nativeItem.id, media.episode);
  if (r.kind !== "resolved") return r;
  const { tmdbId, tmdbKind, tmdbSeason, tmdbEpisode } = r.value;
  // The derived media is identified by the crosswalk's TMDB id (not the source
  // cour id), so overwrite `ids` and the seasoned tracker resolves by tmdb.
  return {
    kind: "resolved",
    media:
      tmdbKind === "movie"
        ? {
            ...media,
            mediaType: "movie",
            ids: { tmdb: tmdbId },
            season: undefined,
            episode: undefined,
          }
        : {
            ...media,
            mediaType: "show",
            ids: { tmdb: tmdbId },
            season: tmdbSeason ?? undefined,
            episode: tmdbEpisode,
          },
  };
}

/**
 * Like {@link deriveMedia} but consults the user's local overrides FIRST (local
 * correction › Fribb › miss). A forward override pins/blocks the AniList entry (a
 * MAL pin wins for MAL, else MAL follows the AniList pin through `idMal`); a
 * reverse override pins the TMDB target. Overrides assume offset 0 (a season = a
 * cour), the common correction case; otherwise it falls through to Fribb.
 */
export function deriveMediaWith(
  target: Tracker,
  media: ParsedMedia,
  nativeItem: TrackedItem | null,
  overrides: AnimapOverrides,
  animap: Animap,
): DeriveOutcome {
  if (trackerFamily(target) === "cour") {
    const tmdbId = media.ids?.tmdb;
    if (tmdbId !== undefined) {
      const key = forwardKey(Number(tmdbId), media.season);
      // A pinned movie writes progress 1 (single-episode cour); a series keeps its ep.
      const pinned = (ids: TargetIds): DeriveOutcome => ({
        kind: "resolved",
        ids,
        media: {
          ...media,
          mediaType: "show",
          season: undefined,
          episode: media.mediaType === "movie" ? 1 : media.episode,
        },
      });
      const malPins = overrides.forwardMal ?? {};
      if (target === "mal" && key in malPins) {
        const malId = malPins[key];
        return malId == null ? { kind: "miss" } : pinned({ mal: malId });
      }
      if (key in overrides.forward) {
        const anilistId = overrides.forward[key];
        if (anilistId == null) return { kind: "miss" }; // explicitly "not on AniList"
        return pinned({ anilist: anilistId });
      }
    }
    return deriveMedia(target, media, nativeItem, animap);
  }

  // Seasoned target: reverse. Pins are keyed by AniList id, so only an AniList-native
  // item can hit one.
  if (nativeItem?.tracker === "anilist") {
    const r = overrides.reverse[nativeItem.id];
    if (r) {
      return {
        kind: "resolved",
        media: {
          ...media,
          mediaType: "show",
          ids: { tmdb: r.tmdbId },
          season: r.season ?? undefined,
          episode: media.episode,
        },
      };
    }
  }
  return deriveMedia(target, media, nativeItem, animap);
}
