import type { IdNamespace } from "./schema";

/**
 * The normalized media identity scraped from a page by the engine.
 * This is what gets resolved against a tracker downstream.
 */
export interface ParsedMedia {
  mediaType: "movie" | "show";
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** Identity ids scraped from the page (usually the URL), keyed by namespace
   * (docs/IDENTITY-NAMESPACES.md). When one is present an adapter resolves by id —
   * exact, immune to same-title/remake ambiguity — instead of a title search. For
   * shows an id identifies the show; season/episode still come from their own
   * fields. `imdb` values are strings ("tt…"); tmdb/tvdb/anilist/mal are numeric. */
  ids?: Partial<Record<IdNamespace, string | number>>;
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
