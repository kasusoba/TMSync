import type { ParsedMedia } from "@tmsync/shared";
import { anilistService } from "./anilist/service";
import type { BoundCourPins } from "./cour-pins";
import { malService } from "./mal/service";
import { simklService } from "./simkl/service";
import { traktService } from "./trakt/service";
import type { CourTracker, RatingLevel, Tracker } from "./types";

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
};

/** The background service for a tracker. */
export function getService<T extends Tracker>(tracker: T): TrackerServices[T] {
  return SERVICES[tracker];
}

/** Every tracker's service, in registry order. */
export function allServices(): TrackerService[] {
  return Object.values(SERVICES);
}
