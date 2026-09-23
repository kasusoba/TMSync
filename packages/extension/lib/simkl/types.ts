/** Simkl API types: only the fields TMSync uses. */

/** OAuth token set. Simkl's refresh token does not rotate (the same one comes back). */
export interface SimklTokens {
  access_token: string;
  refresh_token: string;
  /** Access-token lifetime in seconds (7 days today). */
  expires_in: number;
  /** Unix seconds when we stored it (we add this; Simkl doesn't send it). */
  obtained_at: number;
}

/** The section of simkl.com an item lives in (its page URL). */
export type SimklSection = "movies" | "tv" | "anime";

/**
 * What a write taught us about an item: its Simkl id and page. Cached per page
 * item so the UI shows Simkl's own title and links to it from then on.
 */
export interface SimklMatch {
  id: number;
  section: SimklSection;
  title: string;
  year?: number;
}

/** A media object as Simkl echoes it in a scrobble response. */
export interface SimklMediaObject {
  title?: string;
  year?: number;
  ids?: { simkl?: number; simkl_id?: number; slug?: string };
}

/** A scrobble response (fields we read). */
export interface SimklScrobbleResponse {
  action?: "start" | "pause" | "scrobble" | "checkin";
  movie?: SimklMediaObject;
  show?: SimklMediaObject;
  anime?: SimklMediaObject;
}
