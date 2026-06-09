import type { LinkTemplates, ParsedMedia, Recipe } from "@tmsync/shared";
import { storage } from "wxt/utils/storage";
import type { ResolvedIdentity, TraktTokens } from "./trakt/types";

/**
 * All persisted state lives here. The background SW is stateless (constraint
 * #4): it reads everything from storage on each wake. `local` for caches/tokens,
 * never `sync` for secrets.
 */

export const traktTokens = storage.defineItem<TraktTokens | null>("local:trakt_tokens", {
  fallback: null,
});

/** Resolution cache keyed by resolutionCacheKey(media). */
export const resolutionCache = storage.defineItem<Record<string, ResolvedIdentity>>(
  "local:resolution_cache",
  { fallback: {} },
);

/** Origins where the user granted host access and we registered the content script. */
export const enabledOrigins = storage.defineItem<string[]>("local:enabled_origins", {
  fallback: [],
});

/** Recipes authored locally via the element picker (merged with the bundled list). */
export const customRecipes = storage.defineItem<Recipe[]>("local:custom_recipes", {
  fallback: [],
});

/**
 * Cached copy of the versioned recipe list fetched from the repo/CDN (Phase 1
 * source of truth). Validated before storing; refreshed on a TTL by the
 * background worker. `etag` enables conditional (304) refetches.
 */
export interface RemoteRecipes {
  recipes: Recipe[];
  fetchedAt: number;
  etag?: string;
}
export const remoteRecipes = storage.defineItem<RemoteRecipes | null>("local:remote_recipes", {
  fallback: null,
});

/**
 * Quick links: per-SITE "watch on" buttons injected on Trakt pages. Independent
 * of recipes (which are scraping config) — one site can back several recipes, or
 * none. Only `enabled` entries are shown, so the user keeps it to their
 * favourites even as the recipe list grows.
 */
export interface QuickLinkSite extends LinkTemplates {
  id: string;
  name: string;
  enabled: boolean;
  /** "library" = synced from the shared list (templates refresh on sync);
   * "user"/undefined = created or fully owned by the user. */
  source?: "library" | "user";
}
export const quickLinks = storage.defineItem<QuickLinkSite[]>("local:quick_links", {
  fallback: [],
});

/**
 * User corrections: scraped media key → the Trakt identity the user picked.
 * Authoritative over search results (so a wrong auto-match stays fixed).
 */
export const corrections = storage.defineItem<Record<string, ResolvedIdentity>>(
  "local:corrections",
  { fallback: {} },
);

/**
 * Ratings the user set through TMSync, keyed by reviewKey(identity, level, …).
 * A local mirror for instant UI — ratings made on the Trakt website aren't
 * reflected here (we don't pull the full ratings list). 1–10.
 */
export const ratings = storage.defineItem<Record<string, number>>("local:ratings", {
  fallback: {},
});

/**
 * Short-lived cache of the user's Trakt ratings, so the UI can show ratings set
 * on the Trakt website (not just via TMSync). Keyed by Trakt type
 * (movies/shows/seasons/episodes); the inner map is reviewKey → rating, kept
 * compact (just numbers). Refreshed on a TTL — see client.getRemoteRating.
 */
export interface RemoteRatings {
  at: number;
  map: Record<string, number>;
}
export const remoteRatings = storage.defineItem<Record<string, RemoteRatings>>(
  "local:remote_ratings",
  { fallback: {} },
);

/**
 * The user's single note per item (a managed public Trakt comment), keyed by
 * reviewKey. We store the comment id so the note is always edited/deleted, never
 * duplicated.
 */
export interface StoredNote {
  commentId: number;
  text: string;
  spoiler: boolean;
}
export const notes = storage.defineItem<Record<string, StoredNote>>("local:notes", {
  fallback: {},
});

/**
 * Remembered MANUAL picks (sites with no readable title — local-file players,
 * watch parties). Keyed `${recipeId}::${pageKey}` where pageKey is the recipe's
 * manualKey value (or the page title); the value is the media the user chose.
 * Persistent (`local`) so the same file/title auto-resolves next time — the
 * "remember when possible" behaviour. A pick is also stored as a correction
 * (see corrections) so it resolves to the exact Trakt entry the user picked.
 */
export const manualSelections = storage.defineItem<Record<string, ParsedMedia>>(
  "local:manual_selections",
  { fallback: {} },
);

/**
 * Per-tab manual context published by the recipe-matching frame: which manual
 * recipe matched and the current page key. Lets the (top-frame) badge save a
 * manual pick under the right key. Session-scoped, cleared with the tab.
 */
export interface ManualContext {
  recipeId: string;
  pageKey: string;
}
export const manualContexts = storage.defineItem<Record<number, ManualContext>>(
  "session:manual_contexts",
  { fallback: {} },
);

/**
 * Per-tab watch session, keyed by tabId. Set by the recipe-matching frame and
 * updated by whichever frame owns the <video> (which may be a cross-origin
 * iframe). Lives in `session` storage (ephemeral, per browser session) — the
 * background SW reads it on each wake (constraint #4); the content script and
 * storage own the state, not background memory. Used to (a) hand the media to a
 * player iframe and (b) reconcile a stop if a tab dies before a clean one.
 */
export interface TabSession {
  media: ParsedMedia;
  videoSelector: string;
  frame: "auto" | "top" | "iframe";
  /** 0–1; a pause at/after this fraction is committed as a stop. */
  watchedThreshold: number;
  progress: number;
  updatedAt: number;
  /** Frame that owns scrobbling for this tab (first to start). Prevents two
   * frames — e.g. the page + a player iframe — scrobbling the same item. */
  ownerFrameId?: number;
}
export const tabSessions = storage.defineItem<Record<number, TabSession>>("session:tab_sessions", {
  fallback: {},
});

/**
 * Cross-origin http(s) iframe origins seen in a tab over time (accumulated by
 * the top-frame content script), so the popup's per-origin enable list surfaces
 * player iframes that loaded late — not just those present at the popup-open
 * snapshot. Session-scoped; cleared with the tab session.
 */
export const tabFrameOrigins = storage.defineItem<Record<number, string[]>>(
  "session:tab_frame_origins",
  { fallback: {} },
);
