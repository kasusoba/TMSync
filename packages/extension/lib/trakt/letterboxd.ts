/**
 * Trakt → Letterboxd CSV export (pure, server-reusable; no DOM/browser APIs).
 *
 * Reads ONLY from Trakt — Letterboxd is just the output column layout, not a
 * tracker integration (no Letterboxd API/auth/sync; constraint #1 holds). The
 * caller fetches the raw Trakt data; this turns it into Letterboxd's import CSV.
 *
 * Rewatches: we read the *history* (one record per play), not the collapsed
 * "watched" list — so each play becomes its own row with its own date, which
 * Letterboxd imports as a separate diary entry. Rows for the same film with the
 * SAME date would merge on Letterboxd's side, so distinct watched_at is what
 * preserves rewatches.
 */

/** The Letterboxd diary import columns, in order. */
const COLUMNS = [
  "Title",
  "Year",
  "Directors",
  "WatchedDate",
  "Rating",
  "Review",
  "Tags",
  "tmdbID",
  "imdbID",
] as const;

export type LetterboxdRow = Record<(typeof COLUMNS)[number], string>;

// --- minimal structural shapes of the Trakt payloads we consume ---

export interface TraktMovieRef {
  title: string;
  year?: number;
  ids: { trakt: number; imdb?: string; tmdb?: number };
}
/** One item from GET /sync/history/movies (one per play). */
export interface TraktHistoryMovie {
  movie: TraktMovieRef;
  watched_at: string;
}
/** One item from GET /sync/ratings/movies. */
export interface TraktRatedMovie {
  movie: TraktMovieRef;
  rating: number;
  rated_at: string;
}
/** A movie comment, normalised from GET /users/me/comments/all/movies. */
export interface LetterboxdComment {
  movieId: number;
  comment: string;
  isReview: boolean;
}

/** Trakt rating (1–10 int) → Letterboxd (0.5–5.0). Empty string when unrated. */
export function convertRating(traktRating: number | undefined): string {
  if (!traktRating) return "";
  return (traktRating / 2).toFixed(1);
}

/** ISO datetime → "YYYY-MM-DD" (the date part, as stored). Empty when absent. */
export function formatWatchedDate(iso: string | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m?.[1] ?? "";
}

function makeRow(
  movie: TraktMovieRef,
  dateIso: string,
  rating: number | undefined,
  review: string,
): LetterboxdRow {
  return {
    Title: movie.title,
    Year: movie.year != null ? String(movie.year) : "",
    Directors: "", // not present on the Trakt history/ratings endpoints
    WatchedDate: formatWatchedDate(dateIso),
    Rating: convertRating(rating),
    Review: review,
    Tags: "",
    tmdbID: movie.ids.tmdb != null ? String(movie.ids.tmdb) : "",
    imdbID: movie.ids.imdb ?? "",
  };
}

/**
 * Build the Letterboxd rows. One row per play (rewatches preserved). A film's
 * rating + review attach ONLY to its EARLIEST watch — a stable anchor: the
 * earliest date never changes between exports, so a re-import keeps updating the
 * same diary entry instead of spawning a fresh reviewed duplicate on each new
 * rewatch (whereas "most recent" moves every rewatch). It also avoids the review
 * text repeating across every rewatch entry. Movies that were rated but never
 * watched get a single row dated by `rated_at`, so ratings aren't lost. Sorted
 * newest-first.
 */
export function buildLetterboxdRows(input: {
  history: TraktHistoryMovie[];
  ratings: TraktRatedMovie[];
  comments: LetterboxdComment[];
}): LetterboxdRow[] {
  const { history, ratings, comments } = input;

  const ratingsMap = new Map<number, number>();
  for (const r of ratings) ratingsMap.set(r.movie.ids.trakt, r.rating);

  // Best comment per movie: prefer a flagged review, then the longest text.
  const commentsMap = new Map<number, string>();
  const ranked = [...comments].sort(
    (a, b) => Number(b.isReview) - Number(a.isReview) || b.comment.length - a.comment.length,
  );
  for (const c of ranked) if (!commentsMap.has(c.movieId)) commentsMap.set(c.movieId, c.comment);

  const rows: LetterboxdRow[] = [];
  const seen = new Set<number>();

  // Group history by film; newest play first within each group.
  const byMovie = new Map<number, TraktHistoryMovie[]>();
  for (const h of history) {
    const id = h.movie.ids.trakt;
    seen.add(id);
    (byMovie.get(id) ?? byMovie.set(id, []).get(id))?.push(h);
  }
  for (const [id, plays] of byMovie) {
    plays.sort((a, b) => (a.watched_at < b.watched_at ? 1 : a.watched_at > b.watched_at ? -1 : 0));
    plays.forEach((h, i) => {
      const earliest = i === plays.length - 1; // desc order, so the last is oldest
      rows.push(
        makeRow(
          h.movie,
          h.watched_at,
          earliest ? ratingsMap.get(id) : undefined,
          earliest ? (commentsMap.get(id) ?? "") : "",
        ),
      );
    });
  }

  // Rated but never watched → keep the rating with a row dated by rated_at.
  for (const r of ratings) {
    const id = r.movie.ids.trakt;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(makeRow(r.movie, r.rated_at, r.rating, commentsMap.get(id) ?? ""));
  }

  rows.sort((a, b) => (a.WatchedDate < b.WatchedDate ? 1 : a.WatchedDate > b.WatchedDate ? -1 : 0));
  return rows;
}

function escapeCsv(field: string): string {
  return /[",\n\r]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** Serialise rows to a Letterboxd-import CSV string (CRLF line endings). */
export function toLetterboxdCsv(rows: LetterboxdRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) lines.push(COLUMNS.map((c) => escapeCsv(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
