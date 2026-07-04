/**
 * The anime-map crosswalk (multi-track — docs/MULTI-TRACK.md). Resolves an item's
 * identity + episode ACROSS the two numbering systems, so an anime watch can be
 * written to BOTH trackers. Derived from Fribb/anime-lists; shipped as a trimmed
 * `anime-map.seed.json` (bundled seed; CDN refresh wired separately).
 *
 * Two directions, used by whichever tracker the site does NOT natively speak:
 *   - forward  (general/TMDB-native site → AniList): tmdb+season+ep → anilist entry + local ep
 *   - reverse  (dedicated/AniList-native site → Trakt): anilist+ep → tmdb + season + tmdb ep
 *
 * CONSTRAINT: this module is background-side and MUST NOT be imported by the shared
 * `extract()` engine (CLAUDE.md #2 — the one rule that survives the multi-track
 * reversal). It NEVER guesses: every lookup returns resolved | ambiguous | miss.
 *
 * Not to be confused with the `animeCrosswalk` storage item, which is an unrelated
 * local `(host, AniList id) → slug` cache for anime quick links.
 */
import seed from "./anime-map.seed.json";

/** A trimmed crosswalk row. `s`/`o` are TV-only (TMDB season, episode offset). */
export interface AnimapRow {
  /** AniList id. */
  a: number;
  /** TMDB id. */
  t: number;
  /** Which TMDB id namespace (tv and movie ids overlap). */
  k: "tv" | "movie";
  /** TMDB season this AniList entry maps to (tv only). */
  s?: number | null;
  /** Episodes before this entry within its TMDB season (tv only). local = tmdbEp − o. */
  o?: number | null;
}

export type Derive<T> =
  | { kind: "resolved"; value: T }
  | { kind: "ambiguous" } // >1 candidate we can't split → refuse (never guess)
  | { kind: "miss" }; // not in the crosswalk → derived tracker skipped (native-only)

/** Forward hit: the AniList target. `localEpisode` is 0 for movies. */
export interface ForwardHit {
  anilistId: number;
  localEpisode: number;
}

/** Reverse hit: the TMDB/Trakt target. `tmdbEpisode` is 0 for movies. */
export interface ReverseHit {
  tmdbId: number;
  tmdbKind: "tv" | "movie";
  tmdbSeason: number | null;
  tmdbEpisode: number;
}

const off = (r: AnimapRow) => r.o ?? 0;

export class Animap {
  private readonly byTmdb = new Map<string, AnimapRow[]>();
  private readonly byAnilist = new Map<number, AnimapRow[]>();

  constructor(rows: readonly AnimapRow[]) {
    for (const r of rows) {
      const key = `${r.k}:${r.t}`;
      const byT = this.byTmdb.get(key);
      if (byT) byT.push(r);
      else this.byTmdb.set(key, [r]);
      const byA = this.byAnilist.get(r.a);
      if (byA) byA.push(r);
      else this.byAnilist.set(r.a, [r]);
    }
  }

  /**
   * TMDB-native site → AniList. `season`/`episode` may be undefined (movie, or a
   * site with no season). Returns ambiguous when it can't pin a single cour — e.g.
   * a multi-cour show with no season given (absolute numbering; open Q3), or two
   * entries sharing a season+offset.
   */
  forward(
    tmdbId: number,
    kind: "tv" | "movie",
    season: number | undefined,
    episode: number | undefined,
  ): Derive<ForwardHit> {
    const rows = this.byTmdb.get(`${kind}:${tmdbId}`);
    if (!rows?.length) return { kind: "miss" };

    if (kind === "movie") {
      const ids = [...new Set(rows.map((r) => r.a))];
      const only = ids.length === 1 ? ids[0] : undefined;
      return only !== undefined
        ? { kind: "resolved", value: { anilistId: only, localEpisode: 0 } }
        : { kind: "ambiguous" };
    }

    // tv
    const cands = season != null ? rows.filter((r) => (r.s ?? null) === season) : rows;
    const first = cands[0];
    if (!first) return { kind: "miss" };
    if (episode == null) {
      return cands.length === 1
        ? { kind: "resolved", value: { anilistId: first.a, localEpisode: 0 } }
        : { kind: "ambiguous" };
    }
    // Without a season we can't split a multi-cour run by an absolute number.
    if (season == null && cands.length > 1) return { kind: "ambiguous" };

    // Pick the entry whose offset window contains `episode`: the greatest offset
    // strictly below it (offsets are "episodes before this cour" within the season).
    const below = cands.filter((r) => off(r) < episode);
    const pool = below.length ? below : cands;
    let chosen = pool[0] ?? first;
    for (const r of pool) if (off(r) > off(chosen)) chosen = r;
    // Two entries sharing that offset → we can't tell them apart.
    if (cands.filter((r) => off(r) === off(chosen)).length > 1) return { kind: "ambiguous" };

    return {
      kind: "resolved",
      value: { anilistId: chosen.a, localEpisode: episode - off(chosen) },
    };
  }

  /**
   * AniList-native site → TMDB/Trakt. `episode` is the local episode within the
   * cour. Ambiguous only if one AniList id maps to >1 distinct TMDB target.
   */
  reverse(anilistId: number, episode: number | undefined): Derive<ReverseHit> {
    const rows = this.byAnilist.get(anilistId);
    if (!rows?.length) return { kind: "miss" };
    const distinct = [...new Map(rows.map((r) => [`${r.k}:${r.t}:${r.s ?? ""}`, r])).values()];
    if (distinct.length > 1) return { kind: "ambiguous" };
    const r = distinct[0];
    if (!r) return { kind: "miss" };
    if (r.k === "movie") {
      return {
        kind: "resolved",
        value: { tmdbId: r.t, tmdbKind: "movie", tmdbSeason: null, tmdbEpisode: 0 },
      };
    }
    return {
      kind: "resolved",
      value: {
        tmdbId: r.t,
        tmdbKind: "tv",
        tmdbSeason: r.s ?? null,
        tmdbEpisode: (episode ?? 0) + off(r),
      },
    };
  }
}

/** The bundled crosswalk. Rebuilt per SW wake (cheap, ~8k rows). */
export const defaultAnimap = new Animap(seed as AnimapRow[]);
