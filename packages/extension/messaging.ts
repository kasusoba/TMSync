import type { AniListSearchOption } from "@/lib/anilist/client";
import type { ScoreFormat } from "@/lib/anilist/types";
import type { RatingLevel, Tracker, WatchedState } from "@/lib/tracker/types";
import type { ResolvedIdentity, ScrobbleAction, TraktSearchOption } from "@/lib/trakt/types";
import type { ParsedMedia } from "@tmsync/shared";
import { defineExtensionMessaging } from "@webext-core/messaging";

export interface ScrobbleRequest {
  action: ScrobbleAction;
  media: ParsedMedia;
  /** 0–100. */
  progress: number;
  /** The PRIMARY/native tracker — its numbering is what the page speaks; recorded
   * directly. Default trakt. */
  tracker?: Tracker;
  /** MULTI-TRACK (docs/MULTI-TRACK.md): the full toggled set. Any tracker beyond
   * the native one is DERIVED via the anime-map crosswalk. Omitted ⇒ [tracker]
   * (native-only, unchanged behaviour). */
  trackers?: Tracker[];
  /** 0–1; the per-recipe "treat as finished here" point (AniList owns the watched decision). */
  watchedThreshold?: number;
}

/** Per-derived-tracker outcome for the badge (multi-track). `skipped` = a silent
 * crosswalk miss (not an error — the item just isn't anime / isn't mapped). */
export interface DerivedOutcome {
  tracker: Tracker;
  ok: boolean;
  action?: "start" | "pause" | "scrobble";
  reason?: string;
  skipped?: boolean;
  completed?: boolean;
  resolvedTitle?: string;
}

export interface ScrobbleReply {
  ok: boolean;
  /** HTTP status from Trakt (when a call was made). */
  status?: number;
  /** False when the title couldn't be resolved against Trakt. */
  resolved: boolean;
  /** Trakt's echoed action; "scrobble" means it was added to history. */
  action?: "start" | "pause" | "scrobble";
  /** Why a scrobble failed, for the badge. `numbering_mismatch` is the AniList
   * guardrail; `needs_rewatch` means a COMPLETED AniList cour needs a rewatch
   * confirmation before anything is written. */
  reason?:
    | "not_connected"
    | "unresolved"
    | "no_episode"
    | "numbering_mismatch"
    | "needs_rewatch"
    | "http";
  /** AniList only: this write completed the cour (drives the cour-rating prompt). */
  completed?: boolean;
  /** What this resolved to on Trakt (transparency for the badge). */
  resolvedTitle?: string;
  resolvedYear?: number;
  /** Trakt's error body on an http failure (for diagnosis in the badge). */
  httpError?: string;
  /** MULTI-TRACK: outcomes for the DERIVED tracker(s) written this same phase,
   * so the badge can surface "Trakt ✓ · AniList ⚠ numbering". Empty/absent for a
   * single-tracker recipe. */
  derived?: DerivedOutcome[];
  /** MULTI-TRACK: which tracker these top-level fields describe (the native one, or
   * the first enabled when the native isn't recorded). Lets the badge name it
   * correctly. Absent ⇒ the recipe's own tracker. */
  primaryTracker?: Tracker;
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
  /** An already-COMPLETED AniList cour is being re-watched — the badge shows a
   * "rewatching?" confirmation; nothing is written until the user says yes. */
  rewatch?: boolean;
  /** AniList only: the last write finished the cour (gates the cour-rating prompt). */
  completed?: boolean;
  /** Dismiss the badge entirely — sent when an SPA navigates away from a
   * scrobblable page so a stale "watching" badge doesn't linger. */
  hide?: boolean;
}

export interface TabMedia {
  media: ParsedMedia;
  /** The PRIMARY/native tracker this tab's item routes to. */
  tracker: Tracker;
  /** MULTI-TRACK: the full toggled set (native + derived). Omitted ⇒ [tracker]. */
  trackers?: Tracker[];
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

/** Per-tracker resolution readout for the current item (multi-track): what each
 * enabled tracker matched, or why it didn't — powers the rate/correct UI so it can
 * show real destinations and gate actions (e.g. don't offer to rate on AniList when
 * the item isn't anime). */
export interface TrackerResolution {
  tracker: Tracker;
  resolved: boolean;
  title?: string;
  id?: number;
  /** When unresolved: "no_match" (crosswalk miss / not anime) | "ambiguous" |
   * "unresolved" (searched, nothing) | "http". */
  reason?: string;
}

/** AniList account status (the second, independent provider — constraint #1). */
export interface AniListStatus {
  connected: boolean;
  /** The redirect URI to register in the AniList app (shown in the options page). */
  redirectUri: string;
  /** Whether a client id is configured at all (so the UI can explain if not). */
  configured: boolean;
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
  /** AniList account (independent of Trakt — an item routes to one, never both). */
  getAniListStatus(): AniListStatus;
  connectAniList(): { ok: boolean; error?: string };
  disconnectAniList(): void;
  scrobble(req: ScrobbleRequest): ScrobbleReply;
  /** Resolve scraped media to its tracker identity WITHOUT recording — lets the
   * badge show the matched title before the user presses play (transparency). */
  resolveMedia(q: { media: ParsedMedia; tracker?: Tracker }): {
    resolved: boolean;
    /** The resolved tracker item id (Trakt id / AniList Media id) — lets the
     * content script key the anime crosswalk by the matched AniList entry. */
    id?: number;
    title?: string;
    year?: number;
    mediaType?: "movie" | "show";
  };
  /** MULTI-TRACK: resolve the current media on EACH enabled tracker (read-only,
   * native direct + derived via the crosswalk) so the rate/correction UI can show
   * per-tracker destinations and gate actions. */
  resolveAll(q: { media: ParsedMedia; trackers?: Tracker[] }): TrackerResolution[];
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
  /** The media the top frame published for a tab. A content script omits `tabId`
   * (its own tab is inferred from the sender); the popup passes the active tabId. */
  getTabMedia(q?: { tabId?: number }): TabMedia | null;
  /** The viewer's watched progress for this tab's resolved show — "last watched /
   * next up" for the popup. Resolves (cached) then reads the routed tracker; null
   * for movies, unresolved titles, or when not connected. */
  getWatchedState(q?: { tabId?: number }): WatchedState | null;
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
    /** Popup supplies the active tabId; a content script omits it. */
    tabId?: number;
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
  setEpisode(q: { season: number; episode: number; tabId?: number }): { ok: boolean };
  /** Matcher frame publishes (or clears) this tab's manual context so the badge
   * knows which recipe + page key a pick belongs to. */
  publishManualContext(ctx: { recipeId: string; pageKey: string } | null): void;
  /** Badge/popup reads the manual context for a tab (popup passes the active tabId). */
  getManualContext(q?: { tabId?: number }): { recipeId: string; pageKey: string } | null;

  // --- corrections (fix a wrong match) ---
  /** Free-text Trakt search for the correction picker. */
  searchTrakt(q: { query: string; type?: "movie" | "show" }): TraktSearchOption[];
  /** Persist a correction for the scraped media and re-resolve the tab. */
  saveCorrection(data: { media: ParsedMedia; identity: ResolvedIdentity; tabId?: number }): void;
  /** Free-text AniList search for the DERIVED-tracker correction picker (multi-track). */
  searchAniList(q: { query: string }): AniListSearchOption[];
  /** Pin (or block, via `anilistId: null`) the AniList entry for this TMDB item — a
   * local override above the Fribb crosswalk (docs/MULTI-TRACK.md) — then re-resolve. */
  setAniListMatch(q: { media: ParsedMedia; anilistId: number | null; tabId?: number }): {
    ok: boolean;
    error?: string;
  };
  /** Clear the AniList override for this TMDB item — fall back to the Fribb crosswalk
   * (undo a pin or a "Not on AniList"). Then re-resolve the tab. */
  resetAniListMatch(q: { media: ParsedMedia; tabId?: number }): { ok: boolean };
  /** Background → frames: a correction landed, re-resolve the current session. */
  recheck(): void;

  /** Confirm a rewatch of an already-COMPLETED AniList cour (the badge prompt).
   * Switches the entry to REPEATING and records this episode; on the final
   * episode it re-completes and bumps the repeat count. */
  confirmRewatch(q: { media: ParsedMedia; tabId?: number }): {
    ok: boolean;
    error?: string;
    completed?: boolean;
  };

  // --- ratings & notes (Trakt: managed public comment per level; AniList: cour entry) ---
  /** Which rating levels the routed tracker supports for this media, plus the
   * AniList score format when relevant — so the badge renders only valid
   * affordances (Trakt: show/season/episode; AniList: a single "cour"). */
  getRatingMeta(q: { media: ParsedMedia; tracker?: Tracker }): {
    levels: RatingLevel[];
    scoreFormat?: ScoreFormat;
  };
  /** Current rating (1–10) and note for an item at a level, from the local mirror. */
  getReview(q: { media: ParsedMedia; level: RatingLevel; tracker?: Tracker }): {
    rating: number | null;
    note: { text: string; spoiler: boolean } | null;
  };
  /** Set a 1–10 rating (AniList: stored as scoreRaw = rating×10 on the cour entry). */
  rateItem(q: { media: ParsedMedia; level: RatingLevel; rating: number; tracker?: Tracker }): {
    ok: boolean;
    error?: string;
  };
  /** Remove the rating. */
  unrateItem(q: { media: ParsedMedia; level: RatingLevel; tracker?: Tracker }): {
    ok: boolean;
    error?: string;
  };
  /** Create or edit the single note (Trakt: ≥5 words, public; AniList: private cour note). */
  saveNote(q: {
    media: ParsedMedia;
    level: RatingLevel;
    text: string;
    spoiler: boolean;
    tracker?: Tracker;
  }): {
    ok: boolean;
    error?: string;
  };
  /** Delete the note. */
  deleteNote(q: { media: ParsedMedia; level: RatingLevel; tracker?: Tracker }): {
    ok: boolean;
    error?: string;
  };
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
