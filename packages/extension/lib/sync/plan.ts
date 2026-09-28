/**
 * The list sync planner (plans/list-sync.md). Pure: lists in, a plan out, no I/O,
 * so every edge case is a unit test.
 *
 * The rules, in short:
 *  - Union: each tracker gets what the others have. Nothing is ever removed, and
 *    progress never goes down.
 *  - Items are matched by id only, never by title.
 *  - Movies and non-anime TV move between the trackers that take seasons (Trakt,
 *    Simkl) by their shared tmdb / imdb / tvdb ids. No crosswalk.
 *  - Anime is planned per cour (one AniList entry). A seasoned list (Trakt) reaches
 *    a cour through the crosswalk, and the crosswalk never guesses: a miss or an
 *    ambiguous map is a skip, reported, never a write.
 *  - A completed cour entry is never moved (no silent rewatch).
 *  - Ratings only fill empty ones. Two different ratings are a conflict for the user.
 *  - Status: when the progress finishes the entry, it is completed. Otherwise the
 *    most recently updated entry wins, and a disagreement is listed as a conflict.
 */
import type { Animap } from "../trackers/animap/index";
import type { CourStatus } from "../trackers/cour-plan";
import { TRACKER_INFO, type Tracker, trackerFamily } from "../trackers/types";
import { type ScoreScale, onScale } from "./score";
import type {
  EpisodeRef,
  ListEntry,
  ListSyncSettings,
  SyncConflict,
  SyncIds,
  SyncItem,
  SyncKind,
  SyncPlan,
  SyncSkip,
  SyncTotals,
  SyncWrite,
  TargetRef,
} from "./types";

export interface PlanInput {
  /** Every entry read from the trackers taking part. */
  entries: ListEntry[];
  /** The trackers taking part (connected, and their list was read). */
  trackers: Tracker[];
  settings: ListSyncSettings;
  animap: Animap;
  /** Each tracker's score scale. A missing tracker rates 1 to 10. */
  scales?: Partial<Record<Tracker, ScoreScale>>;
}

type CourEntry = Extract<ListEntry, { shape: "cour" }>;
type SeasonedEntry = Extract<ListEntry, { shape: "seasons" | "movie" }>;

/** The kinds a tracker can take at all: a cour tracker holds only anime. Pure. */
export function syncKindsFor(tracker: Tracker): SyncKind[] {
  return trackerFamily(tracker) === "cour" ? ["anime"] : ["movie", "tv", "anime"];
}

/** Whether a tracker takes part in a kind, after the user's choice. Pure. */
export function takesKind(tracker: Tracker, kind: SyncKind, settings: ListSyncSettings): boolean {
  if (!syncKindsFor(tracker).includes(kind)) return false;
  return (settings.kinds[tracker] ?? syncKindsFor(tracker)).includes(kind);
}

/** COMPLETED and REPEATING both mean "finished at least once". */
const finished = (s: CourStatus | null | undefined) => s === "COMPLETED" || s === "REPEATING";

/** Status as compared across trackers: a rewatch is a completed entry. */
const norm = (s: CourStatus): CourStatus => (s === "REPEATING" ? "COMPLETED" : s);

/** Episodes a cour entry counts as watched. A finished entry counts in full, even
 * mid-rewatch (AniList REPEATING at 3 of 12 still means 12 were watched). */
function courCount(e: CourEntry): number {
  if (e.movie) return e.progress > 0 || finished(e.status) ? 1 : 0;
  return finished(e.status) ? Math.max(e.progress, e.total ?? e.progress) : e.progress;
}

/** A seasoned list's part in one cour: its entry, and the cour's episodes it has. */
interface SeasonedPart {
  entry: SeasonedEntry;
  local: Set<number>;
}

interface CourGroup {
  anilist?: number;
  mal?: number;
  title: string;
  year?: number;
  movie: boolean;
  cour: CourEntry[];
  seasoned: SeasonedPart[];
}

// --- small helpers ---

function idKeys(e: SeasonedEntry): string[] {
  const t = e.shape === "movie" ? "movie" : "tv";
  const out: string[] = [];
  if (e.ids.tmdb !== undefined) out.push(`${t}:tmdb:${e.ids.tmdb}`);
  if (e.ids.imdb) out.push(`${t}:imdb:${e.ids.imdb}`);
  if (e.ids.tvdb !== undefined) out.push(`${t}:tvdb:${e.ids.tvdb}`);
  return out;
}

function mergeIds(entries: { ids: SyncIds }[]): SyncIds {
  const ids: SyncIds = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.ids) as [keyof SyncIds, never][]) {
      if (v !== undefined && ids[k] === undefined) ids[k] = v;
    }
  }
  return ids;
}

function hasEpisode(e: SeasonedEntry, season: number, episode: number): boolean {
  return e.shape === "seasons" && (e.seasons[season] ?? []).includes(episode);
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
    for (const k of idKeys(e)) {
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

// --- the planner ---

export function planSync(input: PlanInput): SyncPlan {
  const { settings, animap } = input;
  const scale = (tk: Tracker): ScoreScale => input.scales?.[tk] ?? "ten";
  const taking = new Set(input.trackers);
  const entries = input.entries.filter((e) => taking.has(e.tracker));
  const ignored = new Set(settings.ignore);

  const items: SyncItem[] = [];
  const skips: SyncSkip[] = [];
  const conflicts: SyncConflict[] = [];

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
      planWestern(members, isMovie ? "movie" : "tv");
      continue;
    }
    if (tmdb === undefined) {
      skips.push({
        key: idKeys(first)[0] ?? `${first.tracker}:${first.id}`,
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

  for (const [key, g] of cours) planCour(key, g);

  return { items, skips, conflicts };

  // --- movies and non-anime TV (Trakt, Simkl; no crosswalk) ---
  function planWestern(all: SeasonedEntry[], kind: SyncKind): void {
    const first = all[0] as SeasonedEntry;
    const ids = mergeIds(all);
    const key = idKeys({ ...first, ids } as SeasonedEntry)[0] ?? `${first.tracker}:${first.id}`;
    if (ignored.has(key)) {
      skips.push({ key, title: first.title, reason: "ignored" });
      return;
    }
    const members = all.filter((m) => takesKind(m.tracker, kind, settings));
    const targets = input.trackers.filter(
      (tk) => trackerFamily(tk) !== "cour" && takesKind(tk, kind, settings),
    );
    const writes: SyncWrite[] = [];
    const own = (tk: Tracker) => members.find((m) => m.tracker === tk);
    const ref = (tk: Tracker): TargetRef => ({
      id: own(tk)?.id,
      ids,
      mediaType: kind === "movie" ? "movie" : "show",
    });

    if (kind === "movie") {
      const watched = members.some((m) => m.shape === "movie" && m.watched);
      for (const tk of targets) {
        const mine = own(tk);
        if (watched && !(mine?.shape === "movie" && mine.watched)) {
          writes.push({ tracker: tk, op: "movie", target: ref(tk) });
        }
      }
    } else {
      const union = new Map<string, EpisodeRef>();
      for (const m of members) {
        if (m.shape !== "seasons") continue;
        for (const [s, eps] of Object.entries(m.seasons)) {
          for (const n of eps) union.set(`${s}:${n}`, { season: Number(s), number: n });
        }
      }
      for (const tk of targets) {
        const mine = own(tk);
        const add = [...union.values()].filter(
          (ep) => !(mine && hasEpisode(mine, ep.season as number, ep.number)),
        );
        if (add.length)
          writes.push({ tracker: tk, op: "episodes", target: ref(tk), add: sortEps(add) });
      }
    }

    // Ratings: the movie, or the whole show.
    const level = kind === "movie" ? "movie" : "show";
    const rated = members.flatMap((m) =>
      m.rating !== null ? [{ tracker: m.tracker, value: m.rating, at: m.updatedAt }] : [],
    );
    fillRatings(
      key,
      first.title,
      rated,
      targets.filter((tk) => own(tk)?.rating == null || !own(tk)),
      (tk) => ({
        level,
        target: ref(tk),
      }),
      writes,
    );

    push(key, kind, first.title, first.year, writes);
  }

  // --- anime, one cour at a time ---
  function planCour(key: string, g: CourGroup): void {
    if (ignored.has(key)) {
      skips.push({ key, title: g.title, reason: "ignored" });
      return;
    }
    if (!settings.includePrivate && g.cour.some((e) => e.private)) {
      skips.push({ key, title: g.title, reason: "private" });
      return;
    }
    if (!settings.includeAdult && g.cour.some((e) => e.adult)) {
      skips.push({ key, title: g.title, reason: "adult" });
      return;
    }
    const cour = g.cour.filter((e) => takesKind(e.tracker, "anime", settings));
    const seasoned = g.seasoned.filter((p) => takesKind(p.entry.tracker, "anime", settings));
    const targets = input.trackers.filter((tk) => takesKind(tk, "anime", settings));
    const title = cour.find((e) => e.tracker === "anilist")?.title ?? cour[0]?.title ?? g.title;
    const year = cour[0]?.year ?? g.year;
    const total = g.movie ? 1 : (cour.find((e) => e.total !== null)?.total ?? null);

    // The union of progress. A seasoned list counts to its highest episode (the
    // same rule as scrobbling: `max(remote, ep)`).
    const courMax = Math.max(0, ...cour.map(courCount));
    const seasonedMax = Math.max(0, ...seasoned.map((p) => Math.max(0, ...p.local)));
    const progress = Math.max(courMax, seasonedMax);
    const repeat = Math.max(0, ...cour.map((e) => e.repeat));

    // Status: finished by progress, else the most recent entry.
    const withStatus = cour
      .filter((e): e is CourEntry & { status: CourStatus } => e.status !== null)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const done = total !== null && progress >= total && progress > 0;
    const latest = withStatus[0];
    let desired: CourStatus | null = done
      ? "COMPLETED"
      : latest
        ? norm(latest.status)
        : progress > 0
          ? "CURRENT"
          : null;
    if (desired === "PLANNING" && progress > 0) desired = "CURRENT";
    const distinct = new Set(withStatus.map((e) => norm(e.status)));
    if (!done && latest && distinct.size > 1) {
      conflicts.push({
        key,
        title,
        field: "status",
        values: withStatus.map((e) => ({ tracker: e.tracker, value: e.status, at: e.updatedAt })),
        chosen: { tracker: latest.tracker, value: norm(latest.status) },
      });
    }

    const writes: SyncWrite[] = [];
    const idsFor: SyncIds = { anilist: g.anilist, mal: g.mal };
    const own = (tk: Tracker) => cour.find((e) => e.tracker === tk);
    const part = (tk: Tracker) => seasoned.find((p) => p.entry.tracker === tk);
    const ratingRefs = new Map<
      Tracker,
      { level: "movie" | "show" | "season" | "entry"; season?: number; target: TargetRef }
    >();

    const rt = g.anilist !== undefined ? animap.ratingTarget(g.anilist) : null;

    for (const tk of targets) {
      const entry = own(tk);
      const p = part(tk);
      const asSeasoned = p !== undefined || (!entry && trackerFamily(tk) === "seasoned");
      if (asSeasoned) {
        seasonedTarget(tk, p);
      } else {
        courTarget(tk, entry);
      }
    }

    // Ratings: every rated source, on whatever level maps to the cour.
    const rated: { tracker: Tracker; value: number; at?: number }[] = [];
    for (const e of cour)
      if (e.rating !== null) rated.push({ tracker: e.tracker, value: e.rating, at: e.updatedAt });
    for (const p of seasoned) {
      const v =
        rt?.kind === "season"
          ? p.entry.shape === "seasons"
            ? p.entry.seasonRatings?.[rt.season]
            : undefined
          : rt
            ? p.entry.rating
            : undefined;
      if (v != null) rated.push({ tracker: p.entry.tracker, value: v, at: p.entry.updatedAt });
    }
    const hasRating = new Set(rated.map((r) => r.tracker));
    fillRatings(
      key,
      title,
      rated,
      [...ratingRefs.keys()].filter((tk) => !hasRating.has(tk)),
      (tk) => ratingRefs.get(tk) as NonNullable<ReturnType<typeof ratingRefs.get>>,
      writes,
    );

    push(key, "anime", title, year, writes);

    /** A tracker that keeps a count and a status (AniList, MAL, Simkl anime). */
    function courTarget(tk: Tracker, entry: CourEntry | undefined): void {
      const ns = TRACKER_INFO[tk].ownNamespace;
      const id = entry?.id ?? (ns ? idsFor[ns] : undefined);
      const hasId = ns
        ? id !== undefined
        : idsFor.anilist !== undefined || idsFor.mal !== undefined;
      const target: TargetRef = {
        id: entry?.id,
        ids: { ...idsFor, ...(ns && id !== undefined ? { [ns]: id } : {}) },
        mediaType: g.movie ? "movie" : "show",
        anime: true,
      };
      if (!hasId) {
        if (progress > 0 || desired) skips.push({ key, title, tracker: tk, reason: "no_id" });
        return;
      }
      ratingRefs.set(tk, { level: "entry", target });
      if (entry && finished(entry.status)) {
        // Never move a completed entry. A higher rewatch count is still news.
        if (repeat > entry.repeat) {
          writes.push({
            tracker: tk,
            op: "entry",
            target,
            create: false,
            repeat: { from: entry.repeat, to: repeat },
          });
        }
        return;
      }
      const tTotal = g.movie ? 1 : (entry?.total ?? total);
      if (tTotal !== null && progress > tTotal) {
        skips.push({
          key,
          title,
          tracker: tk,
          reason: "numbering",
          detail: `episode ${progress} of ${tTotal}`,
        });
        return;
      }
      const from = entry?.progress ?? 0;
      const to = Math.max(from, progress);
      let status = desired;
      if (tTotal !== null && to >= tTotal && to > 0) status = "COMPLETED";
      else if (status === "COMPLETED") status = "CURRENT";
      if (status === "PLANNING" && to > 0) status = entry?.status ?? "CURRENT";
      const w: Extract<SyncWrite, { op: "entry" }> = {
        tracker: tk,
        op: "entry",
        target,
        create: !entry,
      };
      if (to !== from) w.progress = { from, to };
      if (status && status !== (entry?.status ?? null))
        w.status = { from: entry?.status ?? null, to: status };
      if (repeat > (entry?.repeat ?? 0)) w.repeat = { from: entry?.repeat ?? 0, to: repeat };
      if (w.progress || w.status || w.repeat) writes.push(w);
    }

    /** A tracker that keeps watched episodes by season (Trakt, Simkl shows). */
    function seasonedTarget(tk: Tracker, p: SeasonedPart | undefined): void {
      // Episodes to add: a count from a cour tracker (1..N), plus the episodes
      // another seasoned list has. Never this list's own max: that would fill its
      // own gaps with episodes nobody watched.
      const wanted = new Set<number>();
      for (let n = 1; n <= courMax; n += 1) wanted.add(n);
      for (const other of seasoned) if (other !== p) for (const n of other.local) wanted.add(n);
      const ns = g.anilist !== undefined ? "anilist" : "mal";
      const cid = g.anilist ?? g.mal;
      if (cid === undefined) return;
      const first = animap.reverse(ns, cid, 1);
      if (first.kind !== "resolved") {
        if (wanted.size) {
          skips.push({
            key,
            title,
            tracker: tk,
            reason: first.kind === "ambiguous" ? "ambiguous" : "not_mapped",
          });
        }
        return;
      }
      const target: TargetRef = {
        id: p?.entry.id,
        ids: { ...(p ? mergeIds([p.entry]) : {}), tmdb: first.value.tmdbId },
        mediaType: first.value.tmdbKind === "movie" ? "movie" : "show",
      };
      if (first.value.tmdbKind === "movie") {
        if (wanted.size && !(p?.entry.shape === "movie" && p.entry.watched)) {
          writes.push({ tracker: tk, op: "movie", target });
        }
      } else {
        const add: EpisodeRef[] = [];
        for (const n of wanted) {
          if (p?.local.has(n)) continue;
          const hit = animap.reverse(ns, cid, n);
          if (hit.kind !== "resolved" || hit.value.tmdbSeason === null) continue;
          add.push({ season: hit.value.tmdbSeason, number: hit.value.tmdbEpisode });
        }
        if (add.length) writes.push({ tracker: tk, op: "episodes", target, add: sortEps(add) });
      }
      if (rt) {
        ratingRefs.set(tk, {
          level: rt.kind,
          season: rt.kind === "season" ? rt.season : undefined,
          target,
        });
      }
    }
  }

  /**
   * Fill the empty ratings of `targets`. All sources must agree on the target's
   * scale; when they do not, it is a conflict and nothing is written.
   */
  function fillRatings(
    key: string,
    title: string,
    rated: { tracker: Tracker; value: number; at?: number }[],
    targets: Tracker[],
    where: (tk: Tracker) => {
      level: "movie" | "show" | "season" | "entry";
      season?: number;
      target: TargetRef;
    },
    writes: SyncWrite[],
  ): void {
    if (!rated.length) return;
    let conflicted = false;
    for (const tk of targets) {
      const values = new Set(rated.map((r) => onScale(r.value, scale(tk))));
      if (values.size > 1) {
        conflicted = true;
        continue;
      }
      const score = [...values][0] as number;
      const w = where(tk);
      writes.push({
        tracker: tk,
        op: "rating",
        level: w.level,
        season: w.season,
        target: w.target,
        score,
      });
    }
    // Sources that disagree on the 1 to 10 scale are a conflict even when no
    // target is empty; the user may want to line them up.
    const tens = new Set(rated.map((r) => onScale(r.value, "ten")));
    if (conflicted || tens.size > 1) {
      conflicts.push({
        key,
        title,
        field: "rating",
        values: [...rated].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
        chosen: null,
      });
    }
  }

  function push(
    key: string,
    kind: SyncKind,
    title: string,
    year: number | undefined,
    writes: SyncWrite[],
  ): void {
    if (writes.length) items.push({ key, kind, title, year, writes });
  }
}

function sortEps(eps: EpisodeRef[]): EpisodeRef[] {
  return eps.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || a.number - b.number);
}

/** Per-tracker totals for the preview. Pure. */
export function summarize(plan: SyncPlan, trackers: Tracker[]): SyncTotals[] {
  const totals = new Map<Tracker, SyncTotals>(
    trackers.map((tk) => [
      tk,
      { tracker: tk, episodes: 0, movies: 0, created: 0, updated: 0, ratings: 0 },
    ]),
  );
  for (const item of plan.items) {
    for (const w of item.writes) {
      const t = totals.get(w.tracker);
      if (!t) continue;
      if (w.op === "episodes") t.episodes += w.add.length;
      else if (w.op === "movie") t.movies += 1;
      else if (w.op === "rating") t.ratings += 1;
      else if (w.create) t.created += 1;
      else t.updated += 1;
    }
  }
  return [...totals.values()];
}
