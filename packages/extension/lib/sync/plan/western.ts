/** Movies and non-anime TV (Trakt, Simkl; no crosswalk). Pure. */
import { type Tracker, trackerFamily, trackerLabel } from "../../trackers/types";
import { entryKeys } from "../base";
import { newest } from "../read-util";
import type { EpisodeRef, SyncKind, SyncWrite, TargetRef } from "../types";
import { type PlanContext, type SeasonedEntry, removedOn } from "./context";
import { fillRatings, ratingNotices } from "./ratings";
import {
  hasEpisode,
  mergeIds,
  removesEntries,
  sharedKeys,
  sortEps,
  stateOf,
  takesKind,
} from "./util";

export function planWestern(ctx: PlanContext, all: SeasonedEntry[], kind: SyncKind): void {
  const { input, settings, ignored, skips, notices, removed } = ctx;
  const { mainFor, mainMissing, removedSince, unreadHas, unratedSince, atBase, push } = ctx;
  const first = all[0] as SeasonedEntry;
  const ids = mergeIds(all);
  const key = sharedKeys(ids, kind === "movie")[0] ?? `${first.tracker}:${first.id}`;
  if (ignored.has(key)) {
    skips.push({ key, title: first.title, reason: "ignored" });
    return;
  }
  if (mainMissing(kind, key, first.title)) return;
  const main = mainFor(kind);
  const members = all.filter((m) => takesKind(m.tracker, kind, settings));
  const targets = input.trackers.filter(
    (tk) => trackerFamily(tk) !== "cour" && takesKind(tk, kind, settings) && tk !== main,
  );
  const writes: SyncWrite[] = [];
  const own = (tk: Tracker) => members.find((m) => m.tracker === tk);
  const ref = (tk: Tracker): TargetRef => ({
    id: own(tk)?.id,
    ids,
    mediaType: kind === "movie" ? "movie" : "show",
  });
  const mainEntry = main ? own(main) : undefined;
  const keys = [...new Set(all.flatMap(entryKeys))];

  // Removed from one list since the last clean sync: remove it from the others.
  const { gone, fresh } = main
    ? { gone: [], fresh: false }
    : removedSince(
        keys,
        targets,
        members.map((m) => m.tracker),
      );
  if (gone.length) {
    for (const m of members) {
      if (removesEntries(m.tracker))
        writes.push({
          tracker: m.tracker,
          op: "remove",
          target: ref(m.tracker),
          was: stateOf(m),
        });
      else if (fresh)
        notices.push({
          key,
          title: first.title,
          kind,
          tracker: m.tracker,
          reason: "history_kept",
          detail: removedOn(gone),
        });
    }
    // A kept copy (watch history, or a list not read this run) would add it back
    // next time: mark it removed.
    if (members.some((m) => !removesEntries(m.tracker)) || unreadHas(keys))
      for (const tk of targets) if (removesEntries(tk)) removed.push({ tracker: tk, keys });
    push(key, kind, first.title, first.year, writes);
    return;
  }

  // A main list without this item: remove it from the others.
  if (main && !mainEntry) {
    for (const m of members) {
      if (removesEntries(m.tracker))
        writes.push({
          tracker: m.tracker,
          op: "remove",
          target: ref(m.tracker),
          was: stateOf(m),
        });
      else
        notices.push({
          key,
          title: first.title,
          kind,
          tracker: m.tracker,
          reason: "history_kept",
        });
    }
    push(key, kind, first.title, first.year, writes);
    return;
  }
  // With a main list, only it is a source.
  const sources = mainEntry ? [mainEntry] : members;

  if (kind === "movie") {
    const seen = sources.filter((m) => m.shape === "movie" && m.watched);
    const watched = seen.length > 0;
    const at = newest(...seen.map((m) => m.updatedAt));
    if (main && !watched) {
      for (const m of members) {
        if (m.tracker !== main && m.shape === "movie" && m.watched) {
          notices.push({
            key,
            title: first.title,
            kind,
            tracker: m.tracker,
            reason: "ahead",
            detail: `watched here, not on ${trackerLabel(main)}`,
          });
        }
      }
    }
    for (const tk of targets) {
      const mine = own(tk);
      if (watched && !(mine?.shape === "movie" && mine.watched)) {
        writes.push({
          tracker: tk,
          op: "movie",
          target: ref(tk),
          was: mine && stateOf(mine),
          ...(at !== undefined ? { at } : {}),
        });
      }
    }
  } else {
    const union = new Map<string, EpisodeRef>();
    let at: number | undefined;
    for (const m of sources) {
      if (m.shape !== "seasons") continue;
      if (Object.values(m.seasons).some((eps) => eps.length)) at = newest(at, m.updatedAt);
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
        writes.push({
          tracker: tk,
          op: "episodes",
          target: ref(tk),
          add: sortEps(add),
          was: mine && stateOf(mine),
          ...(at !== undefined ? { at } : {}),
        });
    }
    // Episodes a copy has that the main list does not: left as they are.
    if (main) {
      for (const m of members) {
        if (m.tracker === main || m.shape !== "seasons") continue;
        let extra = 0;
        for (const [s, eps] of Object.entries(m.seasons)) {
          for (const n of eps) if (!union.has(`${s}:${n}`)) extra += 1;
        }
        if (extra) {
          notices.push({
            key,
            title: first.title,
            kind,
            tracker: m.tracker,
            reason: "ahead",
            detail: `${extra} watched episode${extra === 1 ? "" : "s"} ${trackerLabel(main)} does not have`,
          });
        }
      }
    }
  }

  // Ratings: the movie, or the whole show.
  const level = kind === "movie" ? "movie" : "show";
  const rated = sources.flatMap((m) =>
    m.rating !== null ? [{ tracker: m.tracker, value: m.rating, at: m.updatedAt }] : [],
  );
  if (main) {
    ratingNotices(
      ctx,
      key,
      first.title,
      kind,
      rated,
      members.flatMap((m) =>
        m.tracker !== main && m.rating !== null ? [{ tracker: m.tracker, value: m.rating }] : [],
      ),
    );
  }
  // A rating removed from one list since the last clean sync: clear it on the others.
  const clear = main
    ? []
    : unratedSince(
        targets.filter((tk) => own(tk)),
        (tk) => own(tk)?.rating != null,
        (tk) => atBase(tk, keys)?.r === 1,
      );
  for (const tk of clear)
    writes.push({ tracker: tk, op: "unrate", level, target: ref(tk), was: own(tk)?.rating ?? 0 });
  if (!clear.length)
    fillRatings(
      ctx,
      key,
      first.title,
      kind,
      rated,
      targets,
      new Set(targets.filter((tk) => own(tk)?.rating != null)),
      (tk) => ({ level, target: ref(tk) }),
      writes,
    );

  push(key, kind, first.title, first.year, writes);
}
