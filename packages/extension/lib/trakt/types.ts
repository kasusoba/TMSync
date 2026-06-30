/** Trakt API types — only the fields TMSync uses. */

/** OAuth token set as returned by POST /oauth/token, plus our storage timestamp. */
export interface TraktTokens {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  /** Lifetime in seconds. */
  expires_in: number;
  /** Unix seconds when the token was issued (Trakt-provided). */
  created_at: number;
  scope: string;
}

export interface TraktIds {
  trakt: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
}

export interface TraktMovie {
  title: string;
  year?: number;
  ids: TraktIds;
}

export interface TraktShow {
  title: string;
  year?: number;
  ids: TraktIds;
}

/** One item from GET /search/movie,show. */
export interface TraktSearchResult {
  type: "movie" | "show" | "episode" | "person" | "list";
  score: number;
  movie?: TraktMovie;
  show?: TraktShow;
}

/**
 * A resolved Trakt identity, cached per scraped (type,title,year). For a show we
 * cache only the show's trakt id; the scraped season/episode are attached at
 * scrobble time (no absolute-numbering translation — constraint #2).
 */
export interface ResolvedIdentity {
  mediaType: "movie" | "show";
  traktId: number;
  title: string;
  year?: number;
  /** URL slug + TMDB id, captured free from the search result. TMDB id powers the
   * Discord RP poster lookup; slug is kept for building Trakt links. */
  slug?: string;
  tmdbId?: number;
}

/** A simplified search result for the correction picker. */
export interface TraktSearchOption {
  type: "movie" | "show";
  traktId: number;
  title: string;
  year?: number;
}

/**
 * What a rating/note targets. A movie has one level; a show episode can be rated
 * or noted at three: the episode, its season, or the whole show.
 */
export type ReviewLevel = "movie" | "show" | "season" | "episode";

/**
 * Body for POST /sync/ratings (and …/remove, which ignores `rating`). Seasons and
 * episodes are addressed BY NUMBER nested under the show's trakt id — so we never
 * need their own trakt ids for ratings (unlike comments).
 */
export interface RatingSyncBody {
  movies?: { ids: { trakt: number }; rating?: number }[];
  shows?: {
    ids: { trakt: number };
    rating?: number;
    seasons?: {
      number: number;
      rating?: number;
      episodes?: { number: number; rating?: number }[];
    }[];
  }[];
}

export type ScrobbleAction = "start" | "pause" | "stop";

/** Body for POST /scrobble/{start,pause,stop}. */
export type ScrobbleBody =
  | { movie: { ids: { trakt: number } }; progress: number }
  | {
      show: { ids: { trakt: number } };
      episode: { season: number; number: number };
      progress: number;
    };

/** Echoed by a successful scrobble call. `action: "scrobble"` means added to history. */
export interface ScrobbleResponse {
  id?: number;
  action: "start" | "pause" | "scrobble";
  progress: number;
}
