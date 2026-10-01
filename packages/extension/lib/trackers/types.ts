/**
 * The tracker-adapter seam (CLAUDE.md → "Tracker adapters"). One interface, N
 * implementations (Trakt, AniList, MAL, Simkl so far), picked per recipe by its tracker list.
 * The shared engine (extract/video/session/badge) stays tracker-agnostic; everything
 * tracker-specific lives behind `TrackerAdapter` + the metadata below.
 */

import type { IdNamespace, ParsedMedia } from "@tmsync/shared";
import type { CourEntry } from "./cour-plan";

/** The trackers — a growing list (multi-track, constraint #1). Add a member here,
 * then a `TRACKER_INFO` entry, an adapter (registered in `getAdapter`), a mark, and
 * a picker toggle. Nothing should switch on the string with an "else ⇒ trakt" default. */
export type Tracker = "trakt" | "anilist" | "mal" | "simkl" | "wetrakr";

/**
 * The fraction of a video after which TMSync treats it as finished (0–1).
 *
 * One engine constant, not recipe data. It matches Trakt's own 80% rule on
 * `/scrobble/stop`, so the stop we send there is always one Trakt counts. For the
 * cour trackers (AniList, MAL) it IS the watched decision. A lower value would
 * mark a part-watched episode as seen, so it must not come from a recipe.
 */
export const WATCHED_THRESHOLD = 0.8;

/**
 * How a tracker numbers episodes. Trackers in one family share numbering, so moving
 * an item between them only changes the id. Moving it between families needs the
 * anime-map crosswalk (`lib/trackers/animap/`), which maps one family to the other.
 *  - `seasoned`: season + episode, keyed by TMDB/IMDB/TVDB ids (Trakt).
 *  - `cour`: one entry per cour, linear episodes, no seasons (AniList, MAL).
 *  - `any`: takes either numbering and maps it server-side (Simkl). It gets the
 *    page's own numbering and ids as they are, never the crosswalk, and is native
 *    only when it is the only enabled tracker.
 */
export type NumberingFamily = "seasoned" | "cour" | "any";

/** What a tracker rates: `levels` = movie / show / season / episode (Trakt);
 * `entry` = only the whole entry (AniList, MAL: the cour; Simkl: the show or movie). */
export type RatingScope = "levels" | "entry";

/** The note a tracker keeps: a `public` comment (Trakt), a `private` note (AniList,
 * MAL), or `none` (Simkl). */
export type NoteKind = "public" | "private" | "none";

/** How the user fixes a wrong match on a tracker: `search` = pick from a search of
 * the tracker (Trakt), `cour` = the cour fix-match panel (AniList, MAL), `none` =
 * nothing to fix (Simkl matches server-side on every write). */
export type FixKind = "search" | "cour" | "none";

/**
 * Static per-tracker metadata, the SINGLE source for a tracker's display name and
 * numbering family. Pure data (no adapter/client code), so it imports weightlessly
 * into the injected UI. Read it through the helpers below instead of comparing
 * tracker names.
 */
export interface TrackerInfo {
  /** Display name (badge, panels, account rows). */
  label: string;
  /** How the tracker numbers episodes. The badge drops the season for a `cour`
   * tracker; derivation uses the crosswalk only across families. */
  family: NumberingFamily;
  /** The id namespace of the tracker's OWN ids, when that namespace is one the
   * crosswalk knows (AniList ids are `anilist`). Trakt ids are not a namespace. */
  ownNamespace?: IdNamespace;
  /** What the rating panel can rate on this tracker. */
  rates: RatingScope;
  /** What kind of note the rating panel can write to this tracker. */
  note: NoteKind;
  /** The fewest words the tracker takes in a note (Trakt rejects shorter comments). */
  noteMinWords?: number;
  /** How a wrong match is fixed (which panel the fix button opens). */
  fix: FixKind;
  /** The account can export its movies as a Letterboxd CSV (`TrackerService.exportLetterboxd`). */
  exportsLetterboxd?: boolean;
  /** The build variables that configure this tracker (named in the Account pane when
   * a build lacks them). */
  env: readonly string[];
  /** Host access the tracker needs: an API that sends no CORS headers, or the site
   * its quick links run on. The UI asks for it on the Connect click (`access.ts`),
   * never at install. `site` names it to the user. */
  hostAccess?: { origins: readonly string[]; site: string };
}

// Order matters: `ALL_TRACKERS` follows it, and native inference takes the first
// match. Simkl stays last (it is native only when it stands alone anyway).
const INFO = {
  trakt: {
    label: "Trakt",
    family: "seasoned",
    rates: "levels",
    note: "public",
    noteMinWords: 5,
    fix: "search",
    exportsLetterboxd: true,
    env: ["WXT_TRAKT_CLIENT_ID", "WXT_TRAKT_CLIENT_SECRET"],
  },
  wetrakr: {
    label: "WeTrakr",
    family: "seasoned",
    rates: "levels",
    note: "public",
    fix: "search",
    exportsLetterboxd: true,
    env: ["WXT_WETRAKR_CLIENT_ID"],
    // The site too: one prompt also covers its quick links (wetrakr-quicklinks).
    hostAccess: {
      origins: ["https://api.wetrakr.com/*", "https://wetrakr.com/*"],
      site: "wetrakr.com",
    },
  },
  anilist: {
    label: "AniList",
    family: "cour",
    ownNamespace: "anilist",
    rates: "entry",
    note: "private",
    fix: "cour",
    env: ["WXT_ANILIST_CLIENT_ID", "WXT_ANILIST_CLIENT_SECRET"],
  },
  mal: {
    label: "MyAnimeList",
    family: "cour",
    ownNamespace: "mal",
    rates: "entry",
    note: "private",
    fix: "cour",
    env: ["WXT_MAL_CLIENT_ID"],
    hostAccess: {
      origins: ["https://myanimelist.net/*", "https://api.myanimelist.net/*"],
      site: "myanimelist.net",
    },
  },
  simkl: {
    label: "Simkl",
    family: "any",
    rates: "entry",
    note: "none",
    fix: "search",
    env: ["WXT_SIMKL_CLIENT_ID"],
    // Its API answers CORS. The site is only for its quick links (simkl-quicklinks).
    hostAccess: { origins: ["https://simkl.com/*"], site: "simkl.com" },
  },
} as const satisfies Record<Tracker, TrackerInfo>;

export const TRACKER_INFO: Record<Tracker, TrackerInfo> = INFO;

/** The trackers fixed through the cour fix-match panel (AniList, MAL). Derived from
 * `TRACKER_INFO`, so a new tracker with `fix: "cour"` joins it with no edit here. */
export type CourTracker = {
  [K in Tracker]: (typeof INFO)[K]["fix"] extends "cour" ? K : never;
}[Tracker];

/** How a wrong match is fixed on a tracker. */
export const trackerFix = (tracker: Tracker): FixKind => TRACKER_INFO[tracker].fix;

/** Whether a tracker is fixed through the cour fix-match panel. */
export const isCourFix = (tracker: Tracker): tracker is CourTracker =>
  trackerFix(tracker) === "cour";

/** The kinds of quick link, named by the tracker whose templates they use (the
 * stored `tracker` value): `trakt` = movie and TV templates, `anilist` = anime
 * templates. */
export type QuickLinkTracker = "trakt" | "anilist";

/** The quick-link kinds, in display order (the quick-link editors' tabs). */
export const QUICK_LINK_TRACKERS: QuickLinkTracker[] = ["trakt", "anilist"];

/** Each quick-link kind's name in the editors' tabs. */
export const QUICK_LINK_KIND_LABEL: Record<QuickLinkTracker, string> = {
  trakt: "Movies & TV",
  anilist: "Anime",
};

/** The trackers whose pages show each kind of quick link (each has a quick-link
 * content script). Simkl's pages show both: its anime pages the anime kind, its
 * movie and TV pages the other. */
export const QUICK_LINK_PAGES: Record<QuickLinkTracker, Tracker[]> = {
  trakt: ["trakt", "wetrakr", "simkl"],
  anilist: ["anilist", "mal", "simkl"],
};

/** All trackers in a stable order — for UI iteration (toggles, tabs) + registries. */
export const ALL_TRACKERS = Object.keys(TRACKER_INFO) as Tracker[];

/** A tracker's display name. Use everywhere instead of `t === "anilist" ? … : "Trakt"`. */
export const trackerLabel = (tracker: Tracker): string => TRACKER_INFO[tracker].label;

/** A tracker's numbering family. */
export const trackerFamily = (tracker: Tracker): NumberingFamily => TRACKER_INFO[tracker].family;

/** Whether a tracker's numbering is seasonless (the `cour` family). */
export const isSeasonless = (tracker: Tracker): boolean => trackerFamily(tracker) === "cour";

/** Whether a tracker takes the page's numbering as is (the `any` family). */
export const isPassthrough = (tracker: Tracker): boolean => trackerFamily(tracker) === "any";

/** The note a tracker keeps (`none` = the rating panel sends it no note). */
export const trackerNote = (tracker: Tracker): NoteKind => TRACKER_INFO[tracker].note;

/** Whether a tracker rates at every level (Trakt) or only the whole entry. */
export const trackerRates = (tracker: Tracker): RatingScope => TRACKER_INFO[tracker].rates;

/** Ids of one entry in other trackers' namespaces. Inside a numbering family these
 * bridge trackers without the crosswalk (an AniList entry's `mal` id is its MAL
 * entry: the two are 1:1). */
export type ExternalIds = Partial<Record<IdNamespace, number>>;

/**
 * A resolved item on a specific tracker: the seam-level identity. A discriminated
 * union, one arm per tracker, each with that tracker's own id. The cour arms
 * (AniList, MAL) also carry the entry's total `episodes` (the numbering-guardrail
 * input, step 6); the Simkl arm carries its page once a write has named it.
 */
export type TrackedItem =
  | {
      tracker: "trakt";
      mediaType: "movie" | "show";
      /** Trakt id. */
      id: number;
      title: string;
      year?: number;
    }
  | {
      tracker: "wetrakr";
      mediaType: "movie" | "show";
      /** WeTrakr id. */
      id: number;
      title: string;
      year?: number;
    }
  | {
      tracker: "anilist";
      /** A cour entry. An anime movie is an entry with one episode, so it is a show here too. */
      mediaType: "show";
      /** AniList `Media` id. */
      id: number;
      title: string;
      year?: number;
      /** Total episodes on the AniList entry; null when unknown/ongoing. */
      episodes: number | null;
      /** Other ids the same entry is known by (AniList `idMal` ⇒ `mal`). */
      ids?: ExternalIds;
    }
  | {
      tracker: "mal";
      /** A cour entry; an anime movie is an entry with one episode, as on AniList. */
      mediaType: "show";
      /** MAL anime id. */
      id: number;
      title: string;
      year?: number;
      /** Total episodes on the MAL entry; null when unknown/ongoing. */
      episodes: number | null;
      /** Other ids the same entry is known by. */
      ids?: ExternalIds;
    }
  | {
      tracker: "simkl";
      mediaType: "movie" | "show";
      /** Simkl id, or 0 until Simkl has matched the item. Simkl matches on every
       * write from the page's ids + title + year, so we never search first. */
      id: number;
      title: string;
      year?: number;
      /** The item's Simkl page, once a write has told us its id and section. */
      url?: string;
      /** The user pinned the id (fix match): writes send it alone. */
      pinned?: boolean;
    };

/** A search result in a cour tracker's fix-match picker (AniList, MAL). Mirrors
 * TraktSearchOption. */
export interface CourSearchOption {
  id: number;
  title: string;
  year?: number;
  episodes: number | null;
  format?: string;
}

/**
 * A search result from any tracker that can search (manual mode's picker). It
 * carries the ids the entry is known by, so a pick resolves that exact entry on
 * the tracker it came from and reaches the others by id or through the crosswalk.
 */
export interface SearchOption {
  tracker: Tracker;
  /** The entry's id on `tracker`. */
  id: number;
  mediaType: "movie" | "show";
  title: string;
  year?: number;
  /** The ids the pick is known by (tmdb/imdb/tvdb for Trakt, its own id for a cour tracker). */
  ids: NonNullable<ParsedMedia["ids"]>;
  /** The entry's format as the tracker names it (a cour tracker's "TV", "MOVIE"). */
  format?: string;
}

/** A progress phase from the content-side scrobble state machine. */
export type RecordPhase = "start" | "pause" | "stop";

/**
 * Coerce a 0 to 100 progress to a finite value, clamp it, and round it to 2
 * decimals. High-precision floats are a known cause of 422 on Trakt /scrobble/*.
 */
export function clampProgress(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(100, Math.max(0, n));
  return Math.round(clamped * 100) / 100;
}

/**
 * A tracker's per-user score scale, for rendering the score affordance. The
 * values are AniList's (`Viewer.mediaListOptions.scoreFormat`), the only tracker
 * that lets the user pick one.
 */
export type ScoreFormat = "POINT_100" | "POINT_10_DECIMAL" | "POINT_10" | "POINT_5" | "POINT_3";

/**
 * Normalized outcome of `recordProgress`, mapped to a `ScrobbleReply` by the
 * background. Adapters never throw for connection/HTTP issues — they fold them
 * into `reason` so the background stays tracker-agnostic.
 */
export interface RecordResult {
  ok: boolean;
  /** Underlying HTTP status, when a call was made. */
  status?: number;
  /** Echoed/normalized action; "scrobble" = committed (a history add, or a list write). */
  action?: "start" | "pause" | "scrobble";
  /**
   * Why it failed, or why nothing was written. `needs_rewatch` = a completed cour
   * entry (AniList, MAL) was re-watched; we wrote nothing and the badge must ask
   * the user to confirm a rewatch first (never silently mutate a completed entry).
   */
  reason?:
    | "unresolved"
    | "no_episode"
    | "numbering_mismatch"
    | "needs_rewatch"
    | "not_connected"
    | "http";
  /** Cour trackers only: this write finished the cour (drives the cour-rating prompt). */
  completed?: boolean;
  /** Tracker error body / detail for the badge. */
  httpError?: string;
  /** Benign informational outcome (ok, but nothing written). `already_watched` =
   * the scraped episode is at/below the tracker's recorded progress, so it won't
   * advance — surfaced to the badge instead of a confusing "stopped". */
  info?: "already_watched";
  /** With `info: "already_watched"`: the tracker's current progress (episode #). */
  atEpisode?: number;
}

/**
 * Which rating affordances a tracker offers for an item — drives the badge so it
 * renders only supported levels (Trakt: show/season/episode; AniList, MAL: the cour
 * entry; Simkl: the movie or show). "cour" is the single entry level of a cour
 * tracker (no per-episode score).
 */
export type RatingLevel = "movie" | "show" | "season" | "episode" | "cour";

/** A single episode reference. `season` is omitted for a cour tracker (linear cour). */
export interface WatchedEpisode {
  season?: number;
  number: number;
}

/**
 * The viewer's watched progress for a resolved show — drives the popup
 * "last watched / next up" line. Normalized across very different storage models:
 * Trakt keeps a true per-episode SET (gaps possible: watched 1,3 not 2), the cour
 * trackers (AniList, MAL) keep only a high-water-mark COUNT (no gaps). Both reduce
 * to this shape; `hasGaps` flags the Trakt-only case where `next` points *behind*
 * `lastWatched`. Simkl reports none (reading it back costs its daily quota).
 */
export interface WatchedState {
  tracker: Tracker;
  /** Episodes that exist to watch (aired count for Trakt; the cour total for a cour
   * tracker); null if unknown/ongoing. */
  total: number | null;
  /** How many episodes are watched. */
  watchedCount: number;
  /** Most recent watch (by time on Trakt; = progress on a cour tracker); null if none. */
  lastWatched: WatchedEpisode | null;
  /** First unwatched episode in order; null when fully caught up / completed. */
  next: WatchedEpisode | null;
  /** Trakt only: `next` sits before `lastWatched` (an earlier episode is unwatched).
   * Always false for a cour tracker. */
  hasGaps: boolean;
  /** Cour trackers: the entry is COMPLETED (not mid-rewatch), so watching any episode
   * again first asks "Rewatching?". */
  completed?: boolean;
  /** Cour trackers: the list entry as read (null = not on the list), so a caller can
   * plan with `planCourWrite` exactly as the write will. */
  entry?: CourEntry | null;
}
