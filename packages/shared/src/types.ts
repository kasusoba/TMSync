/**
 * The normalized media identity scraped from a page by the engine.
 * This is what gets resolved against Trakt downstream.
 */
export interface ParsedMedia {
  mediaType: "movie" | "show";
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** TMDB id scraped from the page (usually the URL). When present the Trakt
   * adapter resolves by id — exact, immune to same-title/remake ambiguity —
   * instead of a title search. For shows it identifies the show; season/episode
   * still come from their own fields. */
  tmdbId?: number;
}

/**
 * Inputs to the engine. `document` is injected (not a global) so that
 * `@tmsync/shared` stays free of DOM/browser-API dependencies and remains
 * pure + server-reusable. Any parsed `Document` works.
 */
export interface EngineContext {
  document: Document;
  url: string;
}

/**
 * Engine results degrade quietly — extraction never throws into the host page.
 * The content script renders "couldn't read this page" on `{ ok: false }`.
 */
export type ExtractResult = { ok: true; media: ParsedMedia } | { ok: false; error: string };
