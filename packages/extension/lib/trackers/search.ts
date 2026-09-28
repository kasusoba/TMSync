import type { ParsedMedia } from "@tmsync/shared";
import type { SearchOption } from "./types";

/**
 * The media for a manual pick (a page with no readable metadata), from any
 * tracker's search result. It carries the ids the pick is known by, so every
 * tracker resolves it by id: a Trakt pick's tmdb id reaches AniList and MAL through
 * the crosswalk, a cour pick's own id reaches its sibling (AniList and MAL are
 * 1:1), and Simkl matches on either. A movie has no numbering; a cour pick has no
 * season (cour numbering is linear). Pure.
 */
export function pickMedia(option: SearchOption, season?: number, episode?: number): ParsedMedia {
  const ids = Object.fromEntries(
    Object.entries(option.ids).filter(([, v]) => v !== undefined),
  ) as NonNullable<ParsedMedia["ids"]>;
  const base = {
    title: option.title,
    year: option.year,
    ...(Object.keys(ids).length ? { ids } : {}),
  };
  if (option.mediaType === "movie") return { mediaType: "movie", ...base };
  return {
    mediaType: "show",
    ...base,
    ...(season !== undefined ? { season } : {}),
    episode,
  };
}
