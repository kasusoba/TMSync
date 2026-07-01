import type { BadgeStatus } from "@/messaging";
import type { LinkTemplates, ParsedMedia, Recipe } from "@tmsync/shared";
import { storage } from "wxt/utils/storage";
import type { AniListIdentity, AniListTokens } from "./anilist/types";
import type { Tracker } from "./tracker/types";
import type { ResolvedIdentity, TraktTokens } from "./trakt/types";

/**
 * All persisted state lives here. The background SW is stateless (constraint
 * #4): it reads everything from storage on each wake.
 *
 * Storage layers (see STORAGE-SYNC.md):
 *  - `sync:`  user-owned deltas that follow the user across devices via the
 *             browser account — custom recipes, user quick links, corrections,
 *             manual picks, badge prefs. NEVER secrets (tokens) or large caches.
 *  - `local:` per-device — tokens (secrets), caches/mirrors, granted origins,
 *             the resolution/crosswalk data (regenerable).
 *  - `session:` ephemeral per-tab session state.
 *
 * Quota note: `browser.storage.sync` caps items at ~8 KB each / ~100 KB total.
 * The synced items are single keys today (a handful of small entries fits easily);
 * if corrections/recipes ever grow large, move to per-item keys (STORAGE-SYNC.md).
 */

export const traktTokens = storage.defineItem<TraktTokens | null>("local:trakt_tokens", {
  fallback: null,
});

// --- AniList (the anime tracker; routed, never synced with Trakt — constraint #1) ---

/** AniList implicit-grant token (no refresh token; ~1-year validity). */
export const anilistTokens = storage.defineItem<AniListTokens | null>("local:anilist_tokens", {
  fallback: null,
});

/** AniList resolution cache keyed by anilistCacheKey(media). */
export const anilistResolutionCache = storage.defineItem<Record<string, AniListIdentity>>(
  "local:anilist_resolution_cache",
  { fallback: {} },
);

/**
 * Local mirror of the user's AniList cour-entry score, keyed by `Media` id, as a
 * format-agnostic 0–100 `scoreRaw` (rendered per the user's scoreFormat).
 */
export const anilistRatings = storage.defineItem<Record<number, number>>("local:anilist_ratings", {
  fallback: {},
});

/** Local mirror of the AniList private `MediaList.notes`, keyed by `Media` id. */
export const anilistNotes = storage.defineItem<Record<number, string>>("local:anilist_notes", {
  fallback: {},
});

/** Resolution cache keyed by resolutionCacheKey(media). */
export const resolutionCache = storage.defineItem<Record<string, ResolvedIdentity>>(
  "local:resolution_cache",
  { fallback: {} },
);

/**
 * Anime quick-link crosswalk: `${host}:${anilistId}` → the site's REAL series
 * slug/identifier, captured (via a recipe's `canonical` field) whenever TMSync
 * resolves a page on that anime site. Reused to deep-link AniList quick links to
 * the exact page instead of a guessed title-slug (anime sites append unguessable
 * junk to URLs). Local + regenerable on the next watch — the no-backend analogue
 * of MALSync's central id→url map (see STORAGE-SYNC.md / the quicklink crosswalk).
 */
export const animeCrosswalk = storage.defineItem<Record<string, string>>("local:anime_crosswalk", {
  fallback: {},
});

/** Origins where the user granted host access and we registered the content script. */
export const enabledOrigins = storage.defineItem<string[]>("local:enabled_origins", {
  fallback: [],
});

/** Recipes authored locally via the element picker (merged with the bundled list). */
export const customRecipes = storage.defineItem<Recipe[]>("sync:custom_recipes", {
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
  /** Which tracker's pages this link injects on: trakt.tv (movies/TV) or
   * anilist.co (anime). Defaults to "trakt" for back-compat (v1 links). */
  tracker?: Tracker;
  /** "library" = synced from the shared list (templates refresh on sync);
   * "user"/undefined = created or fully owned by the user. */
  source?: "library" | "user";
}
export const quickLinks = storage.defineItem<QuickLinkSite[]>("sync:quick_links", {
  fallback: [],
});

/**
 * User corrections: scraped media key → the Trakt identity the user picked.
 * Authoritative over search results (so a wrong auto-match stays fixed).
 */
export const corrections = storage.defineItem<Record<string, ResolvedIdentity>>(
  "sync:corrections",
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
  "sync:manual_selections",
  { fallback: {} },
);

/**
 * Manual season/episode the user supplied for a show page whose URL carries no
 * episode (e.g. a Cineby `…/tv/{id}?play=true` deep link). Keyed by the page
 * URL. Session-scoped (`session`) on purpose: such a link can resume a different
 * episode on a later visit, so a stale override must not persist across browser
 * restarts. Only S/E-less show URLs ever reach this path, so the URL is an
 * unambiguous key (canonical `…/{season}/{episode}` URLs never need it).
 */
export const episodeOverrides = storage.defineItem<
  Record<string, { season: number; episode: number }>
>("session:episode_overrides", { fallback: {} });

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
  /** Which tracker this session records to (routed by the matched recipe). */
  tracker: Tracker;
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

/**
 * Latest scrobble status per tab — so the popup can show "now scrobbling" + any
 * pending prompt (the toolbar icon is the ambient surface; the popup is where you
 * act). Mirrors what the in-page badge receives. Session-scoped; cleared when the
 * session is dismissed (hide) or the tab is removed.
 */
export const tabStatus = storage.defineItem<Record<number, BadgeStatus>>("session:tab_status", {
  fallback: {},
});

/**
 * On-page badge preferences (a small user pref, so `sync`). The toolbar icon is
 * always the ambient status; the in-page badge is optional and can get in the way
 * of player controls, so let the user hide it or drag it to another edge.
 *   mode: "full" current behaviour · "dot" just the status dot · "off" hidden
 *   position: which screen edge it's docked to + `offset` (0–1) along that edge,
 *     or null = default (bottom-left). Edge-docked so it never lands off-screen
 *     and survives a window resize. The fraction is computed purely in render —
 *     no setState-in-layout-effect (that loop once froze the whole tab).
 */
export interface BadgePrefs {
  mode: "full" | "dot" | "off";
  position: { edge: "left" | "right" | "top" | "bottom"; offset: number } | null;
}
export const badgePrefs = storage.defineItem<BadgePrefs>("sync:badge_prefs", {
  fallback: { mode: "full", position: null },
});
