/** WeTrakr API types: only the fields TMSync uses. */

/** OAuth tokens, plus when we got them. The refresh token rotates on every refresh. */
export interface WetrakrTokens {
  access_token: string;
  refresh_token: string;
  /** Lifetime in seconds (7 days). */
  expires_in: number;
  /** Unix seconds when the token was issued (our clock). */
  obtained_at: number;
}

/** A resolved WeTrakr title. A show is resolved once; season and episode come from
 * the page at scrobble time (no absolute-numbering translation, constraint #2). */
export interface WetrakrIdentity {
  mediaType: "movie" | "show";
  /** WeTrakr id (not a TMDB id: the two id spaces overlap). */
  id: number;
  title: string;
  year?: number;
}

/** External ids WeTrakr keeps for a title. */
export interface WetrakrIds {
  tmdb?: number;
  imdb?: string;
  tvdb?: number;
}

/** A movie or show as GET /movies/{id}, /shows/{id}, and /search return it. */
export interface WetrakrMedia {
  id: number;
  type: "movie" | "show";
  title: string;
  release_date?: string;
  first_air_date?: string;
  /** Detail calls only: search results carry no external ids. */
  ids?: WetrakrIds;
}

export type ScrobbleAction = "start" | "pause" | "stop";

/** Body for POST /scrobble/{start,pause,stop} and DELETE /scrobble/playing. */
export type ScrobbleBody =
  | { movie: { id: number }; progress: number; app_version: string }
  | {
      show: { id: number };
      episode: { season: number; number: number };
      progress: number;
      app_version: string;
    };

/** A scrobble reply. `action: "scrobble"` means the play was logged. `episode` is
 * the episode WeTrakr matched, so a numbering mismatch shows at once. */
export interface ScrobbleReply {
  action: "start" | "pause" | "scrobble" | "checkin";
  progress: number;
  media?: { id: number; type: "movie" | "show"; title: string };
  episode?: { id: number; season_number: number; number: number };
}
