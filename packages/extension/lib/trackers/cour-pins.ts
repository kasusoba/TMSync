import type { ParsedMedia } from "@tmsync/shared";
import { animapOverrides } from "../storage";
import { forwardKey } from "./animap/derive";
import { type CourSearchOption, type CourTracker, type SearchOption, TRACKER_INFO } from "./types";

/**
 * Where each cour tracker keeps its fix-match pins: the crosswalk override map
 * for a tmdb-keyed pin, and the title correction (with the caches to drop so a pin,
 * or its removal, takes effect now).
 */
export interface CourPins<I> {
  search(query: string): Promise<CourSearchOption[]>;
  /** The entry for a picked id (null when the tracker has no such entry). */
  load(id: number): Promise<I | null>;
  /** The `AnimapOverrides` map a tmdb-keyed pin goes in. */
  override: "forward" | "forwardMal";
  /** Set (an identity, or null = "not on the tracker") or clear (undefined) the
   * title correction for this media, and drop its stale auto-resolution. */
  setCorrection(media: ParsedMedia, identity: I | null | undefined): Promise<void>;
}

/** A cour tracker's pins with the identity type bound in (see `bindPins`). */
export interface BoundCourPins {
  search(query: string): Promise<CourSearchOption[]>;
  /** Pin an entry (an id), block it (null = "not on the tracker"), or clear the pin
   * (undefined). `ok: false` when the picked entry can't be loaded. */
  apply(media: ParsedMedia, id: number | null | undefined): Promise<{ ok: boolean }>;
}

/** Bind a tracker's pins. `load` and `setCorrection` share one `I`, so an AniList
 * identity can never land in the MAL corrections. */
export function bindPins<I>(pins: CourPins<I>): BoundCourPins {
  return { search: pins.search, apply: (media, id) => applyCourPin(pins, media, id) };
}

/** Set, block, or clear one cour tracker's pin: the tmdb-keyed crosswalk override
 * and the title correction. */
async function applyCourPin<I>(
  pins: CourPins<I>,
  media: ParsedMedia,
  id: number | null | undefined,
): Promise<{ ok: boolean }> {
  let identity: I | null = null;
  if (id !== null && id !== undefined) {
    identity = await pins.load(id).catch(() => null);
    if (!identity) return { ok: false };
  }
  const tmdbId = media.ids?.tmdb;
  if (tmdbId !== undefined) {
    const ov = await animapOverrides.getValue();
    const key = forwardKey(Number(tmdbId), media.season);
    const pinned = ov[pins.override] ?? {};
    if (id === undefined) {
      if (key in pinned) {
        const { [key]: _gone, ...rest } = pinned;
        await animapOverrides.setValue({ ...ov, [pins.override]: rest });
      }
    } else {
      await animapOverrides.setValue({ ...ov, [pins.override]: { ...pinned, [key]: id } });
    }
  }
  await pins.setCorrection(media, id === undefined ? undefined : identity);
  return { ok: true };
}

/** Set or clear one key of a record in storage. */
export async function setKey<T>(
  item: { getValue(): Promise<Record<string, T>>; setValue(v: Record<string, T>): Promise<void> },
  key: string,
  value: T | undefined,
): Promise<void> {
  const all = await item.getValue();
  if (value === undefined) {
    if (!(key in all)) return;
    delete all[key];
  } else all[key] = value;
  await item.setValue(all);
}

/**
 * Manual-mode search on a cour tracker: its fix-match search, kept to the picked
 * type (an anime movie is a movie-format entry, a series is any other format).
 */
export function courSearch(
  tracker: CourTracker,
  search: (query: string) => Promise<CourSearchOption[]>,
): (query: string, type: "movie" | "show") => Promise<SearchOption[]> {
  const ns = TRACKER_INFO[tracker].ownNamespace;
  return async (query, type) =>
    (await search(query))
      .filter((o) => (o.format?.toLowerCase() === "movie") === (type === "movie"))
      .map((o) => ({
        tracker,
        id: o.id,
        mediaType: type,
        title: o.title,
        year: o.year,
        format: o.format,
        ids: ns ? { [ns]: o.id } : {},
      }));
}
