/** Anime, one cour at a time (one AniList entry). Pure. */
import type { CourStatus } from "../../trackers/cour-plan";
import {
  TRACKER_INFO,
  type Tracker,
  trackerFamily,
  trackerLabel,
  trackerRates,
} from "../../trackers/types";
import { idKeys as baseKeys, entryKeys } from "../base";
import { newest } from "../read-util";
import type {
  EntryState,
  EpisodeRef,
  RatingRef,
  SyncConflict,
  SyncIds,
  SyncWrite,
  TargetRef,
} from "../types";
import { type CourEntry, type PlanContext, removedOn } from "./context";
import type { CourGroup, SeasonedPart } from "./group";
import { fillRatings, ratingNotices } from "./ratings";
import { statusChange } from "./status";
import {
  courCount,
  finished,
  keepsDays,
  keepsRepeat,
  mergeIds,
  normStatus,
  removesEntries,
  sortEps,
  stateOf,
  takesKind,
} from "./util";

export function planCour(ctx: PlanContext, key: string, g: CourGroup): void {
  const { input, settings, animap, ignored, skips, conflicts, notices, removed } = ctx;
  const { mainFor, mainMissing, removedSince, unreadHas, unratedSince, unratedAway, atBase, push } =
    ctx;
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
  if (mainMissing("anime", key, g.title)) return;
  const main = mainFor("anime");
  const cour = g.cour.filter((e) => takesKind(e.tracker, "anime", settings));
  const seasoned = g.seasoned.filter((p) => takesKind(p.entry.tracker, "anime", settings));
  const targets = input.trackers.filter((tk) => takesKind(tk, "anime", settings) && tk !== main);
  const title = cour.find((e) => e.tracker === "anilist")?.title ?? cour[0]?.title ?? g.title;
  const year = cour[0]?.year ?? g.year;
  const total = g.movie ? 1 : (cour.find((e) => e.total !== null)?.total ?? null);

  // With a main list, only it is a source. A seasoned list "has" a cour only
  // when it has watched some of it (every cour of a show gets a part).
  const srcCour = main ? cour.filter((e) => e.tracker === main) : cour;
  const srcSeasoned = main
    ? seasoned.filter((p) => p.entry.tracker === main && p.local.size > 0)
    : seasoned;
  if (main && !srcCour.length && !srcSeasoned.length) {
    removeFromCopies(`${trackerLabel(main)} does not have it`, true);
    return;
  }

  // Where the cour starts in TMDB numbering (its first episode).
  const ns = g.anilist !== undefined ? "anilist" : "mal";
  const cid = g.anilist ?? g.mal;
  const first = cid === undefined ? null : animap.reverse(ns, cid, 1);

  // Removed from one list since the last sync: remove it from the others.
  // The keys: the cour's ids, the show or movie the crosswalk maps it to, and
  // each seasoned list's own ids.
  const courKeys = baseKeys({ anilist: g.anilist, mal: g.mal }, "tv");
  const keys = [
    ...new Set([
      ...courKeys,
      ...(first?.kind === "resolved"
        ? baseKeys({ tmdb: first.value.tmdbId }, first.value.tmdbKind === "movie" ? "movie" : "tv")
        : []),
      ...seasoned.flatMap((p) => entryKeys(p.entry)),
    ]),
  ];
  const holders = [
    ...new Set([
      ...cour.map((e) => e.tracker),
      ...seasoned.filter((p) => p.local.size > 0).map((p) => p.entry.tracker),
    ]),
  ];
  const { gone, fresh } = main ? { gone: [], fresh: false } : removedSince(keys, targets, holders);
  if (gone.length) {
    removeFromCopies(removedOn(gone), fresh);
    // A kept copy (a seasoned list, or a list not read this run) would add it
    // back next time: mark it removed on the cour lists, by the cour's own ids
    // only (a show id names every cour).
    const kept = new Set(seasoned.filter((p) => p.local.size > 0).map((p) => p.entry.tracker));
    if (kept.size || unreadHas(keys))
      for (const tk of targets)
        if (removesEntries(tk) && !kept.has(tk)) removed.push({ tracker: tk, keys: courKeys });
    return;
  }

  // The union of progress. A seasoned list counts to its highest episode (the
  // same rule as scrobbling: `max(remote, ep)`).
  const courMax = Math.max(0, ...srcCour.map(courCount));
  const seasonedMax = Math.max(0, ...srcSeasoned.map((p) => Math.max(0, ...p.local)));
  const progress = Math.max(courMax, seasonedMax);
  const repeat = Math.max(0, ...srcCour.map((e) => e.repeat));
  // Start and finish days: the first start and the last finish the sources keep.
  // A copy gets one only where it has none (sync never changes a day).
  const starts = srcCour.flatMap((e) => (e.startedOn ? [e.startedOn] : [])).sort();
  const finishes = srcCour.flatMap((e) => (e.finishedOn ? [e.finishedOn] : [])).sort();
  const startedOn = starts[0];
  const finishedOn = finishes[finishes.length - 1];
  // The date backfilled watches get: when the sources were last watched.
  const srcAt = newest(
    ...srcCour.filter((e) => courCount(e) > 0).map((e) => e.watchedAt),
    ...srcSeasoned.filter((p) => p.local.size > 0).map((p) => p.entry.watchedAt),
  );

  // A seasoned list keeps one status for the whole show, so it counts for a cour
  // only when the show is this one cour (or the cour is a movie).
  const single =
    first?.kind === "resolved" &&
    (first.value.tmdbKind === "movie" || animap.anilistIds(first.value.tmdbId, "tv").length === 1);

  // Status: finished by progress, else the most recent entry. A seasoned list's
  // "completed" only says what its watches say, which the progress has already.
  type Held = { tracker: Tracker; status: CourStatus; updatedAt?: number; seasoned?: true };
  const held: (Omit<Held, "status"> & { status?: CourStatus | null })[] = [
    ...srcCour.map((e) => ({ tracker: e.tracker, status: e.status, updatedAt: e.updatedAt })),
    ...(single ? srcSeasoned : []).map((p) => ({
      tracker: p.entry.tracker,
      status: p.entry.status,
      updatedAt: p.entry.updatedAt,
      seasoned: true as const,
    })),
  ];
  const withStatus = held
    .filter((e): e is Held => !!e.status && !(e.seasoned && e.status === "COMPLETED"))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const done = total !== null && progress >= total && progress > 0;
  const latest = withStatus[0];
  let desired: CourStatus | null = done
    ? "COMPLETED"
    : latest
      ? normStatus(latest.status)
      : progress > 0
        ? "CURRENT"
        : null;
  if (desired === "PLANNING" && progress > 0) desired = "CURRENT";
  // A seasoned plan to watch with progress is no disagreement: it only lags.
  const distinct = new Set(
    withStatus
      .filter((e) => !(e.seasoned && e.status === "PLANNING" && progress > 0))
      .map((e) => normStatus(e.status)),
  );
  // The disagreement, if any: each cour target adds itself below, so a status the
  // user picks can go to all of them (`withPicks`).
  let statusConflict: SyncConflict | undefined;
  if (!done && latest && distinct.size > 1) {
    statusConflict = {
      key,
      title,
      kind: "anime",
      field: "status",
      values: withStatus.map((e) => ({ tracker: e.tracker, value: e.status, at: e.updatedAt })),
      chosen: { tracker: latest.tracker, value: normStatus(latest.status) },
      targets: [],
    };
    conflicts.push(statusConflict);
  }

  const writes: SyncWrite[] = [];
  const idsFor: SyncIds = { anilist: g.anilist, mal: g.mal };
  const own = (tk: Tracker) => cour.find((e) => e.tracker === tk);
  const part = (tk: Tracker) => seasoned.find((p) => p.entry.tracker === tk);
  const ratingRefs = new Map<Tracker, RatingRef>();

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

  // Ratings: every rated entry, on whatever level maps to the cour. Only the
  // sources fill; every rated tracker keeps its own.
  const allRated: { tracker: Tracker; value: number; at?: number }[] = [];
  for (const e of cour)
    if (e.rating !== null) allRated.push({ tracker: e.tracker, value: e.rating, at: e.updatedAt });
  for (const p of seasoned) {
    const v =
      rt?.kind === "season"
        ? p.entry.shape === "seasons"
          ? p.entry.seasonRatings?.[rt.season]
          : undefined
        : rt
          ? p.entry.rating
          : undefined;
    if (v != null) allRated.push({ tracker: p.entry.tracker, value: v, at: p.entry.updatedAt });
  }
  const rated = main ? allRated.filter((r) => r.tracker === main) : allRated;
  const hasRating = new Set(allRated.map((r) => r.tracker));
  if (main) {
    ratingNotices(
      ctx,
      key,
      title,
      "anime",
      rated,
      allRated.filter((r) => r.tracker !== main),
    );
    // Copies further than the main list: left as they are, and said so.
    for (const e of cour) {
      if (e.tracker !== main && courCount(e) > progress) {
        notices.push({
          key,
          title,
          kind: "anime",
          tracker: e.tracker,
          reason: "ahead",
          detail: `episode ${courCount(e)} here, ${progress} on ${trackerLabel(main)}`,
        });
      }
    }
    for (const p of seasoned) {
      const top = Math.max(0, ...p.local);
      if (p.entry.tracker !== main && top > progress) {
        notices.push({
          key,
          title,
          kind: "anime",
          tracker: p.entry.tracker,
          reason: "ahead",
          detail: `episode ${top} here, ${progress} on ${trackerLabel(main)}`,
        });
      }
    }
  }
  // A rating removed from one list since the last sync: clear it on the
  // others. Only lists that have the entry now, or had it only for its rating; a
  // seasoned list's rating is the level the crosswalk maps the cour to (a season,
  // or the show).
  const clear = main
    ? []
    : unratedSince(
        [...ratingRefs.keys()].filter((tk) => own(tk) || part(tk) || unratedAway(tk, keys)),
        (tk) => hasRating.has(tk),
        (tk) => {
          const b = atBase(tk, keys);
          if (!b) return false;
          if (rt?.kind === "season" && ratingRefs.get(tk)?.level === "season")
            return !!b.s?.includes(rt.season);
          return b.r === 1;
        },
      );
  for (const tk of clear) {
    const ref = ratingRefs.get(tk) as RatingRef;
    const was = allRated.find((r) => r.tracker === tk)?.value ?? 0;
    writes.push({ tracker: tk, op: "unrate", ...ref, was });
  }
  if (!clear.length)
    fillRatings(
      ctx,
      key,
      title,
      "anime",
      rated,
      [...ratingRefs.keys()],
      hasRating,
      (tk) => ratingRefs.get(tk) as RatingRef,
      writes,
    );

  push(key, "anime", title, year, writes);

  /** The main list does not have this cour, or another list removed it (`why`):
   * remove each copy's list entry. A seasoned list (Trakt, or a Simkl show) is
   * kept: it is watch history, or a whole show that holds other cours too. It is
   * said so only when the removal is new (`tell`), not on every later sync. */
  function removeFromCopies(why: string, tell: boolean): void {
    const out: SyncWrite[] = [];
    for (const e of cour) {
      if (removesEntries(e.tracker)) {
        out.push({
          tracker: e.tracker,
          op: "remove",
          target: { id: e.id, ids: e.ids, mediaType: e.movie ? "movie" : "show", anime: true },
          was: stateOf(e),
        });
      }
    }
    for (const p of seasoned) {
      if (tell && p.local.size > 0) {
        notices.push({
          key,
          title,
          kind: "anime",
          tracker: p.entry.tracker,
          reason: "history_kept",
          detail: why,
        });
      }
    }
    push(key, "anime", title, year, out);
  }

  /** A tracker that keeps a count and a status (AniList, MAL, Simkl anime). */
  function courTarget(tk: Tracker, entry: CourEntry | undefined): void {
    const ns = TRACKER_INFO[tk].ownNamespace;
    const id = entry?.id ?? (ns ? idsFor[ns] : undefined);
    const hasId = ns ? id !== undefined : idsFor.anilist !== undefined || idsFor.mal !== undefined;
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
    if (entry && finished(entry.status)) {
      ratingRefs.set(tk, { level: "entry", target });
      // Never move a completed entry. A higher rewatch count, or an empty day
      // filled, is still news.
      const w: Extract<SyncWrite, { op: "entry" }> = {
        tracker: tk,
        op: "entry",
        target,
        create: false,
      };
      if (keepsRepeat(tk) && repeat > entry.repeat) w.repeat = { from: entry.repeat, to: repeat };
      fillDays(tk, w, entry, true);
      if (w.repeat || w.startedOn || w.finishedOn) writes.push(w);
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
    // A rating goes only where there is (or will be) an entry: rating an
    // unlisted item would add it to the list.
    if (entry || progress > 0 || desired) ratingRefs.set(tk, { level: "entry", target });
    const from = entry?.progress ?? 0;
    const to = Math.max(from, progress);
    let status = desired;
    if (tTotal !== null && to >= tTotal && to > 0) status = "COMPLETED";
    else if (status === "COMPLETED") status = "CURRENT";
    if (status === "PLANNING" && to > 0) status = entry?.status ?? "CURRENT";
    statusConflict?.targets?.push({
      tracker: tk,
      target,
      exists: !!entry,
      status: entry?.status ?? null,
      progress: to,
      total: tTotal,
    });
    const w: Extract<SyncWrite, { op: "entry" }> = {
      tracker: tk,
      op: "entry",
      target,
      create: !entry,
    };
    if (to !== from) w.progress = { from, to };
    if (status && status !== (entry?.status ?? null))
      w.status = { from: entry?.status ?? null, to: status };
    if (keepsRepeat(tk) && repeat > (entry?.repeat ?? 0))
      w.repeat = { from: entry?.repeat ?? 0, to: repeat };
    if (w.progress && srcAt !== undefined) w.at = srcAt;
    // A day only goes where there is (or will be) an entry.
    if (entry || w.progress || w.status) fillDays(tk, w, entry, finished(status));
    if (w.progress || w.status || w.repeat || w.startedOn || w.finishedOn) writes.push(w);
  }

  /** Fill the entry's empty start day, and its empty finish day once it is
   * finished (`done`). */
  function fillDays(
    tk: Tracker,
    w: Extract<SyncWrite, { op: "entry" }>,
    entry: CourEntry | undefined,
    done: boolean,
  ): void {
    if (!keepsDays(tk)) return;
    if (startedOn && !entry?.startedOn) w.startedOn = startedOn;
    if (done && finishedOn && !entry?.finishedOn) w.finishedOn = finishedOn;
  }

  /** A tracker that keeps watched episodes by season (Trakt, Simkl shows). */
  function seasonedTarget(tk: Tracker, p: SeasonedPart | undefined): void {
    // Episodes to add: a count from a cour tracker (1..N), plus the episodes
    // another seasoned list has. Never this list's own max: that would fill its
    // own gaps with episodes nobody watched.
    const wanted = new Set<number>();
    for (let n = 1; n <= courMax; n += 1) wanted.add(n);
    for (const other of srcSeasoned) if (other !== p) for (const n of other.local) wanted.add(n);
    if (cid === undefined || !first) return;
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
        writes.push({
          tracker: tk,
          op: "movie",
          target,
          was: p && stateOf(p.entry),
          ...(srcAt !== undefined ? { at: srcAt } : {}),
        });
      }
    } else {
      const add: EpisodeRef[] = [];
      for (const n of wanted) {
        if (p?.local.has(n)) continue;
        const hit = animap.reverse(ns, cid, n);
        if (hit.kind !== "resolved" || hit.value.tmdbSeason === null) continue;
        add.push({ season: hit.value.tmdbSeason, number: hit.value.tmdbEpisode });
      }
      // "had" counts this cour's episodes, not the whole show's.
      const was: EntryState | undefined = p ? { episodes: p.local.size } : undefined;
      if (add.length)
        writes.push({
          tracker: tk,
          op: "episodes",
          target,
          add: sortEps(add),
          was,
          ...(srcAt !== undefined ? { at: srcAt } : {}),
        });
    }
    // The show's (or movie's) status, when the show is this one cour.
    if (single && desired) {
      const shape = first.value.tmdbKind === "movie" ? "movie" : "show";
      const from = p?.entry.status ?? null;
      let to: CourStatus | null = desired;
      if (shape === "movie" && progress > 0) to = null;
      const adds = writes.some(
        (w) => w.tracker === tk && (w.op === "episodes" || w.op === "movie"),
      );
      const gets = (p && (p.local.size > 0 || p.entry.status)) || adds || to === "PLANNING";
      statusConflict?.targets?.push({
        tracker: tk,
        target,
        exists: !!p,
        status: from,
        progress: progress > 0 ? 1 : 0,
        total: null,
        shape,
      });
      const status = gets ? statusChange(tk, shape, from, to) : undefined;
      if (status)
        writes.push({
          tracker: tk,
          op: "status",
          target,
          status,
          ...(p ? { was: stateOf(p.entry) } : {}),
        });
    }
    // A season rating goes only to a list that rates seasons (Trakt). A Simkl show
    // rates as a whole: one cour's score would replace the show's.
    if (rt && (rt.kind !== "season" || trackerRates(tk) === "levels")) {
      ratingRefs.set(tk, {
        level: rt.kind,
        season: rt.kind === "season" ? rt.season : undefined,
        target,
      });
    }
  }
}
