import type { ParsedMedia } from "@tmsync/shared";
import { browser } from "wxt/browser";
import { connectIntent } from "../storage";
import type { ListCache, ListRead } from "../sync/list-cache";
import type { ChunkOutcome, SyncKind, SyncWrite, WriteOutcome } from "../sync/types";
import { hasTrackerAccess, isTrackerGrant } from "./access";
import { anilistService } from "./anilist/service";
import type { BoundCourPins } from "./cour-pins";
import { malService } from "./mal/service";
import { simklService } from "./simkl/service";
import { traktService } from "./trakt/service";
import {
  type CourTracker,
  type RatingLevel,
  type SearchOption,
  TRACKER_INFO,
  type Tracker,
} from "./types";
import { wetrakrService } from "./wetrakr/service";

/** Report some writes of a chunk as done, by their place in the chunk. */
export type ApplyReport = (at: number[], outcome: WriteOutcome) => void;

type Ok = Promise<{ ok: boolean; error?: string }>;

/** A tracker account's state, as the popup and options page show it. */
export interface AccountStatus {
  connected: boolean;
  /** The redirect URI to register in the tracker's app. */
  redirectUri: string;
  /** Whether a client id is configured at all (so the UI can explain if not). */
  configured: boolean;
}

/**
 * The rating + note seam per tracker. Each tracker uses only the params it
 * supports: Trakt rates per level with a spoiler flag, the others rate the entry.
 */
export interface ReviewHandler {
  getReview(
    media: ParsedMedia,
    level: RatingLevel,
  ): Promise<{ rating: number | null; note: { text: string; spoiler: boolean } | null }>;
  rate(media: ParsedMedia, level: RatingLevel, rating: number): Ok;
  unrate(media: ParsedMedia, level: RatingLevel): Ok;
  saveNote(media: ParsedMedia, level: RatingLevel, text: string, spoiler: boolean): Ok;
  deleteNote(media: ParsedMedia, level: RatingLevel): Ok;
}

/**
 * What the background needs from a tracker beyond the scrobble adapter: the
 * account, the rating and note calls, and any work that must run on each service
 * worker wake. The background loops over these and never names a tracker.
 * Everything here is stateless (constraint #4): listeners and alarms are set up
 * again on each wake, and state lives in storage.
 */
export interface TrackerService {
  status(): Promise<AccountStatus>;
  /** Sign in. Throws with a user-facing message when it fails. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  review: ReviewHandler;
  /**
   * Free-text search of this tracker, for manual mode (a site with no readable
   * title). Optional: Simkl has none, since its shared daily quota rules out
   * searching.
   */
  search?(query: string, type: "movie" | "show"): Promise<SearchOption[]>;
  /**
   * Lock this tracker's match to a manual pick, when the pick's ids alone could
   * drift (Trakt keeps a correction). Optional: a cour pick names its entry by id.
   */
  pinPick?(media: ParsedMedia, pick: SearchOption): Promise<void>;
  /**
   * Read the user's whole list for list sync (docs/ARCHITECTURE.md section 7). Read only: it
   * never writes. `kinds` are the kinds this tracker takes part in, so it can skip
   * reads nobody needs. `saved` is the list this tracker saved at its last read,
   * for a tracker with a cheap change check to reuse (`sync/list-cache.ts`); it
   * returns the list to save next in `cache`. `timed` = the automatic daily run
   * asks, not the user (Simkl never reads in full on a timer without its change
   * check). Optional: a tracker without it takes no part in list sync.
   */
  readList?(kinds: SyncKind[], saved: ListCache | null, timed: boolean): Promise<ListRead>;
  /**
   * Write this tracker's part of a list sync plan (docs/ARCHITECTURE.md section 7).
   * The runner sends the writes `chunk` at a time and saves its place after each,
   * so the tracker picks a size that suits its limits. `run` spaces its own
   * requests, answers one result per write, and never throws for one bad item.
   * A tracker that writes one entry at a time may also call `report` as each one
   * is done (the writes' places in the chunk), so the progress moves. Optional,
   * like `readList`.
   */
  applyList?: {
    chunk: number;
    run(writes: SyncWrite[], report?: ApplyReport): Promise<ChunkOutcome>;
  };
  /** A Letterboxd-import CSV of the user's movies (`TRACKER_INFO.exportsLetterboxd`).
   * Throws with a user-facing message when it fails. */
  exportLetterboxd?(): Promise<{ csv: string; count: number }>;
  /** Alarm handlers by alarm name (the tracker creates the alarms itself). */
  alarms?: Record<string, () => Promise<void>>;
  /** Listeners and this tracker's own message handlers (features only it has), set
   * up on each service worker wake. */
  onWake?(): void;
}

/** A cour tracker also keeps fix-match pins (see `cour-pins.ts`). */
export interface CourTrackerService extends TrackerService {
  pins: BoundCourPins;
}

export type TrackerServices = {
  [K in Tracker]: K extends CourTracker ? CourTrackerService : TrackerService;
};

/**
 * The background service registry. A map, like the adapter registry in
 * `index.ts`: the background never switches on a tracker name. Adding a tracker =
 * one entry here, and the type makes a cour tracker bring its pins. Kept out of
 * `index.ts` so content scripts do not bundle the account and review code.
 */
const SERVICES: TrackerServices = {
  trakt: traktService,
  anilist: anilistService,
  mal: malService,
  simkl: simklService,
  wetrakr: wetrakrService,
};

/** The background service for a tracker. */
export function getService<T extends Tracker>(tracker: T): TrackerServices[T] {
  return SERVICES[tracker];
}

/** Every tracker's service, in registry order. */
export function allServices(): TrackerService[] {
  return Object.values(SERVICES);
}

/** How long a popup's connect intent stays good (the user answers the prompt). */
const INTENT_MS = 2 * 60 * 1000;

/**
 * Sign in to a tracker. A tracker with `hostAccess` needs the grant first: the UI
 * asks for it on the Connect click, a gesture the background does not have.
 */
export async function connectTracker(tracker: Tracker): Promise<void> {
  if (!(await hasTrackerAccess(tracker))) {
    throw new Error(`Allow access to ${TRACKER_INFO[tracker].label} to connect`);
  }
  await getService(tracker).connect();
}

/**
 * Finish a sign-in after a first host grant. Firefox closes the popup at the
 * permission prompt, so the popup cannot ask for the sign-in; it left an intent.
 * A listener set up on each wake (constraint #4).
 */
export function watchConnectGrants(): void {
  browser.permissions.onAdded.addListener(async (granted) => {
    const intent = await connectIntent.getValue();
    if (!intent || Date.now() - intent.at > INTENT_MS) return;
    if (!isTrackerGrant(intent.tracker, granted.origins)) return;
    await connectIntent.setValue(null);
    await connectTracker(intent.tracker).catch((e) =>
      console.warn(`[TMSync] ${TRACKER_INFO[intent.tracker].label} sign-in failed`, e),
    );
  });
}
