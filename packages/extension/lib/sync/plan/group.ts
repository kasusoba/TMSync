/**
 * Grouping the entries: cour groups keyed by AniList id (else MAL id), and the
 * seasoned lists joined to them through the crosswalk. Non-anime seasoned groups
 * go to `western` as they are found, so the plan keeps its order. Pure.
 */
import { trackerFamily } from "../../trackers/types";
import type { SyncKind } from "../types";
import type { CourEntry, PlanContext, SeasonedEntry } from "./context";
import { sharedKeys } from "./util";

/** A seasoned list's part in one cour: its entry, and the cour's episodes it has. */
export interface SeasonedPart {
  entry: SeasonedEntry;
  local: Set<number>;
}

export interface CourGroup {
  anilist?: number;
  mal?: number;
  title: string;
  year?: number;
  movie: boolean;
  cour: CourEntry[];
  seasoned: SeasonedPart[];
}

/** Group seasoned entries that share any id (a small union-find). */
function groupSeasoned(entries: SeasonedEntry[]): SeasonedEntry[][] {
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  const byKey = new Map<string, number>();
  entries.forEach((e, i) => {
    for (const k of sharedKeys(e.ids, e.shape === "movie")) {
      const j = byKey.get(k);
      if (j === undefined) byKey.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, SeasonedEntry[]>();
  entries.forEach((e, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(e);
    else groups.set(r, [e]);
  });
  return [...groups.values()];
}

/** Every cour group of the run. Calls `western` for each non-anime seasoned group. */
export function groupEntries(
  ctx: PlanContext,
  western: (members: SeasonedEntry[], kind: SyncKind) => void,
): Map<string, CourGroup> {
  const { entries, animap, skips, input } = ctx;
  const seasonedEntries = entries.filter((e): e is SeasonedEntry => e.shape !== "cour");
  const courEntries = entries.filter((e): e is CourEntry => e.shape === "cour");

  // --- cour groups, keyed by AniList id (else MAL id) ---
  const malToAnilist = new Map<number, number>();
  for (const e of courEntries) {
    const a = e.ids.anilist;
    const m = e.ids.mal;
    if (a !== undefined && m !== undefined) malToAnilist.set(m, a);
  }
  const anilistOf = (mal: number | undefined) =>
    mal === undefined ? undefined : (malToAnilist.get(mal) ?? animap.anilistForMal(mal));

  const cours = new Map<string, CourGroup>();
  const courGroup = (
    anilist: number | undefined,
    mal: number | undefined,
    title: string,
    year: number | undefined,
    movie: boolean,
  ): CourGroup | null => {
    const a = anilist ?? anilistOf(mal);
    const m = mal ?? (a !== undefined ? animap.malForAnilist(a) : undefined);
    const key = a !== undefined ? `anilist:${a}` : m !== undefined ? `mal:${m}` : null;
    if (!key) return null;
    let g = cours.get(key);
    if (!g) {
      g = { title, year, movie, cour: [], seasoned: [] };
      cours.set(key, g);
    }
    g.anilist ??= a;
    g.mal ??= m;
    return g;
  };

  for (const e of courEntries) {
    const g = courGroup(e.ids.anilist, e.ids.mal, e.title, e.year, !!e.movie);
    if (!g) {
      skips.push({ key: `${e.tracker}:${e.id}`, title: e.title, reason: "no_id" });
      continue;
    }
    g.cour.push(e);
  }

  // --- seasoned groups: non-anime is planned here, anime joins the cour groups ---
  for (const members of groupSeasoned(seasonedEntries)) {
    const first = members[0] as SeasonedEntry;
    const isMovie = first.shape === "movie";
    const tmdb = members.find((m) => m.ids.tmdb !== undefined)?.ids.tmdb;
    const anime =
      members.some((m) => m.anime) ||
      (tmdb !== undefined && animap.has(tmdb, isMovie ? "movie" : "tv"));

    if (!anime) {
      western(members, isMovie ? "movie" : "tv");
      continue;
    }
    if (tmdb === undefined) {
      skips.push({
        key: sharedKeys(first.ids, isMovie)[0] ?? `${first.tracker}:${first.id}`,
        title: first.title,
        reason: "not_mapped",
        detail: "anime with no TMDB id",
      });
      continue;
    }
    if (isMovie) {
      const ids = animap.anilistIds(tmdb, "movie");
      if (ids.length !== 1) {
        skips.push({
          key: `movie:tmdb:${tmdb}`,
          title: first.title,
          reason: ids.length ? "ambiguous" : "not_mapped",
        });
        continue;
      }
      const g = courGroup(ids[0], undefined, first.title, first.year, true);
      for (const m of members) {
        g?.seasoned.push({ entry: m, local: new Set(m.shape === "movie" && m.watched ? [1] : []) });
      }
      continue;
    }
    // A show: every cour of it gets each member as a part (so a cour the member
    // has not started is still a place to add episodes).
    const parts = new Map<string, Map<SeasonedEntry, SeasonedPart>>();
    for (const a of animap.anilistIds(tmdb, "tv")) {
      const g = courGroup(a, undefined, first.title, first.year, false);
      if (!g) continue;
      const byEntry = new Map<SeasonedEntry, SeasonedPart>();
      for (const m of members) {
        const part = { entry: m, local: new Set<number>() };
        g.seasoned.push(part);
        byEntry.set(m, part);
      }
      parts.set(`anilist:${a}`, byEntry);
    }
    for (const m of members) {
      if (m.shape !== "seasons") continue;
      let unmapped = 0;
      for (const [s, eps] of Object.entries(m.seasons)) {
        for (const ep of eps) {
          const hit = animap.forward(tmdb, "tv", Number(s), ep);
          const part =
            hit.kind === "resolved"
              ? parts.get(`anilist:${hit.value.anilistId}`)?.get(m)
              : undefined;
          if (part && hit.kind === "resolved") part.local.add(hit.value.localEpisode);
          else unmapped += 1;
        }
      }
      if (unmapped > 0 && input.trackers.some((tk) => trackerFamily(tk) === "cour")) {
        skips.push({
          key: `tv:tmdb:${tmdb}`,
          title: m.title,
          tracker: m.tracker,
          reason: "not_mapped",
          detail: `${unmapped} watched episode${unmapped === 1 ? "" : "s"} outside the crosswalk (specials, or a season it does not split)`,
        });
      }
    }
  }

  return cours;
}
