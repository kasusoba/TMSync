import type {
  ResolvedIdentity,
  ReviewLevel,
  ScrobbleAction,
  TraktSearchOption,
} from "@/lib/trakt/types";
import type { ParsedMedia } from "@tmsync/shared";
import { defineExtensionMessaging } from "@webext-core/messaging";

export interface ScrobbleRequest {
  action: ScrobbleAction;
  media: ParsedMedia;
  /** 0–100. */
  progress: number;
}

export interface ScrobbleReply {
  ok: boolean;
  /** HTTP status from Trakt (when a call was made). */
  status?: number;
  /** False when the title couldn't be resolved against Trakt. */
  resolved: boolean;
  /** Trakt's echoed action; "scrobble" means it was added to history. */
  action?: "start" | "pause" | "scrobble";
  /** Why a scrobble failed, for the badge. */
  reason?: "not_connected" | "unresolved" | "no_episode" | "http";
  /** What this resolved to on Trakt (transparency for the badge). */
  resolvedTitle?: string;
  resolvedYear?: number;
  /** Trakt's error body on an http failure (for diagnosis in the badge). */
  httpError?: string;
}

export type BadgeState = "idle" | "watching" | "paused" | "scrobbled" | "stopped" | "error";

export interface BadgeStatus {
  state: BadgeState;
  /** e.g. "The Pixel Frontier S2E4". */
  title?: string;
  /** short human detail, e.g. "added to history" or "not connected". */
  detail?: string;
  /** Manual mode awaiting a selection — the badge shows a "pick what you're
   * watching" prompt instead of (or alongside) the status line. */
  pick?: boolean;
  /** A show page whose URL carries no episode (e.g. a "?play=true" deep link) —
   * the badge shows a season/episode chooser so scrobbling can start. */
  needEpisode?: boolean;
}

export interface TabMedia {
  media: ParsedMedia;
  videoSelector: string;
  /** Where the player lives: which frame should drive scrobbling. */
  frame: "auto" | "top" | "iframe";
  /** 0–1; a pause at/after this fraction is committed as a stop. */
  watchedThreshold: number;
}

export interface TraktStatus {
  connected: boolean;
  /** The redirect URI to register in the Trakt app (shown in the popup). */
  redirectUri: string;
}

/**
 * Typed content↔background↔popup contract. Background handlers are stateless and
 * read everything from storage on each call (constraint #4).
 */
export interface ProtocolMap {
  ping(): "pong";
  getTraktStatus(): TraktStatus;
  connectTrakt(): { ok: boolean; error?: string };
  disconnectTrakt(): void;
  scrobble(req: ScrobbleRequest): ScrobbleReply;
  /** Resolve scraped media to its Trakt identity WITHOUT scrobbling — lets the
   * badge show the matched title before the user presses play (transparency). */
  resolveMedia(media: ParsedMedia): {
    resolved: boolean;
    title?: string;
    year?: number;
    mediaType?: "movie" | "show";
  };
  /** Force-refresh the CDN recipe list; returns how many recipes are now cached. */
  refreshRecipes(): { ok: boolean; count: number; error?: string };
  /** Build a Letterboxd-import CSV from the user's Trakt movie history, ratings
   * and reviews (rewatches included). Client-side only — the CSV is returned to
   * the page to download; nothing is sent anywhere new (constraint #6). */
  exportLetterboxd(): { ok: boolean; csv?: string; count?: number; error?: string };
  /** Register the content script for an origin the user just granted access to. */
  registerSite(origin: string): { ok: boolean; error?: string };
  unregisterSite(origin: string): { ok: boolean };
  listEnabledSites(): string[];

  // --- per-tab session coordination (top frame ↔ player iframe ↔ background) ---
  /** The recipe-matching frame publishes the media so a cross-origin player iframe can pick it up. */
  publishMedia(data: TabMedia): void;
  /** A player iframe asks for the media the top frame published for this tab. */
  getTabMedia(): TabMedia | null;
  /** Playing frame reports latest progress (reconciliation safety net). */
  updateProgress(progress: number): void;
  /** Playing frame signals a clean stop so the background won't re-reconcile. */
  endSession(): void;
  /** Playing frame reports scrobble state; background relays to the top frame's badge. */
  reportScrobble(status: BadgeStatus): void;
  /** Top frame reports cross-origin iframe origins it has seen (accumulated for the popup). */
  reportFrameOrigins(origins: string[]): void;
  /** Background → top frame: update the badge. */
  scrobbleStatus(status: BadgeStatus): void;

  // --- manual mode (sites with no readable title) ---
  /** The remembered manual pick for (recipeId, pageKey), or null. */
  getManualMedia(q: { recipeId: string; pageKey: string }): ParsedMedia | null;
  /** Set what's playing on a manual site: saves a correction (so it resolves to
   * the exact picked Trakt entry) + remembers it by (recipeId, pageKey), then
   * re-resolves the tab so scrobbling starts. */
  setManualMedia(q: {
    recipeId: string;
    pageKey: string;
    media: ParsedMedia;
    identity: ResolvedIdentity;
  }): { ok: boolean };
  /** The remembered manual season/episode for this tab's URL, or null. Read via
   * the background because the override lives in `session` storage, which
   * content scripts cannot access directly. */
  getEpisodeOverride(): { season: number; episode: number } | null;
  /** Drop the override stored for a specific URL — sent by the matcher frame when
   * it navigates away from an S/E-less URL, so a later return re-prompts instead
   * of silently reusing a stale episode (the URL can resume a different one). */
  clearEpisodeOverride(q: { url: string }): void;
  /** Stop this tab's scrobble session and tell every frame to re-evaluate. The
   * matcher frame sends this when it can no longer determine what's playing (an
   * S/E-less URL with no override) so a stale player-iframe session can't keep
   * the badge — and Trakt — on the previous episode. */
  stopTabSession(): void;
  /** The user supplied the season/episode for a show URL that carries none
   * (e.g. a "?play=true" deep link). Persists it keyed by the tab's URL and
   * re-resolves the tab so scrobbling starts. */
  setEpisode(q: { season: number; episode: number }): { ok: boolean };
  /** Matcher frame publishes (or clears) this tab's manual context so the badge
   * knows which recipe + page key a pick belongs to. */
  publishManualContext(ctx: { recipeId: string; pageKey: string } | null): void;
  /** Badge reads the manual context for its tab. */
  getManualContext(): { recipeId: string; pageKey: string } | null;

  // --- corrections (fix a wrong match) ---
  /** Free-text Trakt search for the correction picker. */
  searchTrakt(q: { query: string; type?: "movie" | "show" }): TraktSearchOption[];
  /** Persist a correction for the scraped media and re-resolve the tab. */
  saveCorrection(data: { media: ParsedMedia; identity: ResolvedIdentity }): void;
  /** Background → frames: a correction landed, re-resolve the current session. */
  recheck(): void;

  // --- ratings & notes (a managed public Trakt comment per item) ---
  /** Current rating (1–10) and note for an item at a level, from the local mirror. */
  getReview(q: { media: ParsedMedia; level: ReviewLevel }): {
    rating: number | null;
    note: { text: string; spoiler: boolean } | null;
  };
  /** Set a 1–10 rating. */
  rateItem(q: { media: ParsedMedia; level: ReviewLevel; rating: number }): {
    ok: boolean;
    error?: string;
  };
  /** Remove the rating. */
  unrateItem(q: { media: ParsedMedia; level: ReviewLevel }): { ok: boolean; error?: string };
  /** Create or edit the single note (Trakt requires ≥5 words). */
  saveNote(q: { media: ParsedMedia; level: ReviewLevel; text: string; spoiler: boolean }): {
    ok: boolean;
    error?: string;
  };
  /** Delete the note. */
  deleteNote(q: { media: ParsedMedia; level: ReviewLevel }): { ok: boolean; error?: string };
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
