/**
 * The user's crosswalk pins (`AnimapOverrides`) folded into the Fribb rows, for
 * list sync. Scrobbling reads the pins per watch (`deriveWithOverrides`); list
 * sync plans a whole library through one `Animap`, so it needs the pins as rows.
 * Pure: rows in, rows out.
 *
 * Only pins that name a TV season become rows. A forward pin with no season is
 * keyed `${tmdbId}:`, and that key does not say if the id is a movie or a show
 * (TMDB's two id spaces overlap), so it is left out and the Fribb rows stay.
 *
 * Where scrobbling is narrower, sync is stricter, never looser: "not on AniList"
 * for a season drops that season's rows, so MAL does not reach it either (sync
 * then skips it and reports it, instead of writing a guess).
 */
import type { AnimapOverrides } from "./derive";
import type { AnimapRow } from "./index";

/** A forward pin key (`${tmdbId}:${season}`) as a TV season, or null. Pure. */
function seasonKey(key: string): { t: number; s: number } | null {
  const [t, s] = key.split(":");
  if (!t || !s) return null;
  const tn = Number(t);
  const sn = Number(s);
  return Number.isInteger(tn) && Number.isInteger(sn) ? { t: tn, s: sn } : null;
}

export function withOverrides(rows: readonly AnimapRow[], ov: AnimapOverrides): AnimapRow[] {
  const malOf = (a: number) => rows.find((r) => r.a === a && r.m != null)?.m ?? null;
  const inSeason = (r: AnimapRow, t: number, s: number) =>
    r.k === "tv" && r.t === t && (r.s ?? null) === s;
  let out = rows.map((r) => ({ ...r }));

  // Reverse pins: an AniList entry is this TMDB season, from its first episode.
  for (const [id, to] of Object.entries(ov.reverse)) {
    const a = Number(id);
    out = out.filter((r) => r.a !== a);
    out.push({ a, m: malOf(a), t: to.tmdbId, k: "tv", s: to.season, o: 0 });
  }

  // Forward pins: this TMDB season is one AniList entry (local episode = TMDB
  // episode), or not on AniList at all.
  for (const [key, a] of Object.entries(ov.forward)) {
    const at = seasonKey(key);
    if (!at) continue;
    out = out.filter((r) => !inSeason(r, at.t, at.s));
    if (a == null) continue;
    out = out.filter((r) => r.a !== a);
    out.push({ a, m: malOf(a), t: at.t, k: "tv", s: at.s, o: 0 });
  }

  // MAL pins: the MAL entry of this TMDB season. With more than one row in the
  // season the pin cannot say which one it is, so none keeps a MAL id.
  for (const [key, m] of Object.entries(ov.forwardMal ?? {})) {
    const at = seasonKey(key);
    if (!at) continue;
    const hits = out.filter((r) => inSeason(r, at.t, at.s));
    const pinned = hits.length === 1 ? m : null;
    // AniList and MAL are one to one: the pinned MAL id leaves any other entry.
    if (pinned != null) for (const r of out) if (r.m === pinned) r.m = null;
    for (const r of hits) r.m = pinned;
  }
  return out;
}
