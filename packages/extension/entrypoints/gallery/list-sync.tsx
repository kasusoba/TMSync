/** List sync states for the gallery, with mock lists run through the REAL planner,
 * so the tiles show what the pane renders, not a hand-written imitation. */
import { APPLY_JOB_VERSION, type ApplyJob, applyBlock, applyQueues } from "@/lib/sync/apply";
import { type BaseEntry, baseOf } from "@/lib/sync/base";
import { planSync, summarize, syncKindsFor } from "@/lib/sync/plan/index";
import type { SyncPreview } from "@/lib/sync/preview";
import { DEFAULT_SYNC_SETTINGS, type ListEntry, type ListSyncSettings } from "@/lib/sync/types";
import { Animap } from "@/lib/trackers/animap/index";
import { ALL_TRACKERS, type Tracker } from "@/lib/trackers/types";
import { type Variant, tokens } from "@/lib/ui/kit/kit";
import { ListSyncView } from "@/lib/ui/kit/list-sync/ListSyncView";
import clsx from "clsx";

const animap = new Animap([
  { a: 154587, m: 52991, t: 209867, k: "tv", s: 1, o: null }, // Frieren
  { a: 16498, m: 16498, t: 1429, k: "tv", s: 1, o: null },
  { a: 99147, m: 35760, t: 1429, k: "tv", s: 3, o: null },
  { a: 104578, m: 38524, t: 1429, k: "tv", s: 3, o: 12 },
]);

const entries: ListEntry[] = [
  {
    tracker: "trakt",
    shape: "seasons",
    id: 1,
    title: "Severance",
    year: 2022,
    ids: { tmdb: 95396 },
    rating: 90,
    seasons: { 1: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  },
  {
    tracker: "simkl",
    shape: "seasons",
    id: 2,
    title: "Severance",
    year: 2022,
    ids: { tmdb: 95396 },
    rating: null,
    seasons: { 1: [1, 2, 3] },
  },
  {
    tracker: "trakt",
    shape: "seasons",
    id: 3,
    title: "Attack on Titan",
    year: 2013,
    ids: { tmdb: 1429 },
    rating: null,
    seasons: { 0: [1], 3: [1, 2, 3, 13] },
  },
  {
    tracker: "anilist",
    shape: "cour",
    id: 154587,
    title: "Sousou no Frieren",
    year: 2023,
    ids: { anilist: 154587, mal: 52991 },
    rating: 95,
    progress: 28,
    total: 28,
    status: "COMPLETED",
    repeat: 0,
    updatedAt: 2,
  },
  {
    tracker: "mal",
    shape: "cour",
    id: 52991,
    title: "Sousou no Frieren",
    year: 2023,
    ids: { mal: 52991 },
    rating: 80,
    progress: 10,
    total: 28,
    status: "CURRENT",
    repeat: 0,
    updatedAt: 1,
  },
  {
    tracker: "anilist",
    shape: "cour",
    id: 5,
    title: "A Private Show",
    ids: { anilist: 5 },
    rating: null,
    progress: 3,
    total: 12,
    status: "CURRENT",
    repeat: 0,
    private: true,
  },
  {
    tracker: "trakt",
    shape: "movie",
    id: 9,
    title: "Heat",
    year: 1995,
    ids: { tmdb: 949 },
    rating: 80,
    watched: true,
  },
  // Plan to watch on MyAnimeList only (removed from AniList long ago).
  {
    tracker: "mal",
    shape: "cour",
    id: 47,
    title: "Akira",
    year: 1988,
    ids: { mal: 47 },
    rating: null,
    progress: 0,
    total: 1,
    status: "PLANNING",
    repeat: 0,
    movie: true,
  },
];

const FROM: Partial<Record<Tracker, "saved" | "changes">> = { trakt: "saved", simkl: "changes" };

/** The lists at the last clean sync, for remembered removals: AniList still had
 * Akira (so MyAnimeList loses it now), and Simkl had rated Severance (so Trakt's
 * rating is cleared). */
function galleryBase(): Partial<Record<Tracker, BaseEntry[]>> {
  const was: ListEntry[] = entries.map((e) =>
    e.tracker === "simkl" && e.title === "Severance" ? { ...e, rating: 90 } : e,
  );
  was.push({
    tracker: "anilist",
    shape: "cour",
    id: 47,
    title: "Akira",
    ids: { anilist: 47, mal: 47 },
    rating: null,
    progress: 0,
    total: 1,
    status: "PLANNING",
    repeat: 0,
    movie: true,
  });
  return Object.fromEntries(
    ALL_TRACKERS.map((tk) => [tk, baseOf(was.filter((e) => e.tracker === tk))]),
  );
}

function preview(
  settings: ListSyncSettings,
  trackers: Tracker[],
  base?: Partial<Record<Tracker, BaseEntry[]>>,
): SyncPreview {
  const plan = planSync({
    entries,
    trackers,
    settings,
    animap,
    scales: { anilist: "POINT_100" },
    base,
  });
  return {
    at: Date.UTC(2026, 8, 28, 9, 30),
    reads: ALL_TRACKERS.map((tracker) =>
      trackers.includes(tracker)
        ? {
            tracker,
            state: "read" as const,
            count: entries.filter((e) => e.tracker === tracker).length,
            // Show both short reads: Trakt did not change, Simkl read its changes.
            from: FROM[tracker],
          }
        : { tracker, state: "not_connected" as const },
    ),
    totals: summarize(plan, trackers),
    plan,
    scales: { anilist: "POINT_100" },
  };
}

const noop = () => {};

function rows(settings: ListSyncSettings) {
  return ALL_TRACKERS.map((tk) => ({
    tracker: tk,
    can: syncKindsFor(tk),
    on: settings.kinds[tk] ?? syncKindsFor(tk),
  }));
}

export function ListSyncTile({
  variant,
  state,
}: {
  variant: Variant;
  state:
    | "idle"
    | "preview"
    | "no-simkl-anime"
    | "main-anilist"
    | "too-few"
    | "reading"
    | "stale"
    | "applying"
    | "applied"
    | "auto"
    | "remembered";
}) {
  const t = tokens(variant);
  const settings: ListSyncSettings =
    state === "no-simkl-anime"
      ? { ...DEFAULT_SYNC_SETTINGS, kinds: { simkl: ["movie", "tv"] }, ignore: ["movie:tmdb:1"] }
      : state === "main-anilist"
        ? { ...DEFAULT_SYNC_SETTINGS, main: { anime: "anilist" } }
        : state === "auto"
          ? { ...DEFAULT_SYNC_SETTINGS, auto: true }
          : DEFAULT_SYNC_SETTINGS;
  const p =
    state === "preview" ||
    state === "no-simkl-anime" ||
    state === "main-anilist" ||
    state === "stale" ||
    state === "applying" ||
    state === "applied"
      ? preview(settings, ALL_TRACKERS)
      : state === "auto"
        ? { ...preview(settings, ALL_TRACKERS), auto: true }
        : state === "remembered"
          ? preview(settings, ALL_TRACKERS, galleryBase())
          : state === "too-few"
            ? {
                ...preview(settings, ["trakt"]),
                reason: "too_few" as const,
                totals: [],
                plan: { items: [], skips: [], conflicts: [], notices: [] },
              }
            : null;
  const job =
    p && (state === "applying" || state === "applied" || state === "auto")
      ? applyJob(p.at, state)
      : null;
  // The gallery's "now": just after the preview, or long after it for "stale".
  const now = (p?.at ?? 0) + (state === "stale" ? 11 * 60_000 : 60_000);
  const blocked = p ? applyBlock(p, job, applyQueues(p, settings.ignore, {}), now) : null;
  return (
    <div class={clsx("w-full rounded-xl p-5", t.page)}>
      <ListSyncView
        t={t}
        rows={rows(settings)}
        settings={settings}
        preview={p}
        busy={state === "reading"}
        progress={
          state === "reading"
            ? [
                { tracker: "trakt", state: "read", count: 412 },
                { tracker: "anilist", state: "read", count: 236 },
                { tracker: "mal", state: "reading" },
                { tracker: "simkl", state: "waiting" },
              ]
            : undefined
        }
        onPreview={noop}
        onKind={noop}
        onSetting={noop}
        onMain={noop}
        onIgnore={noop}
        onRestore={noop}
        onClearIgnored={noop}
        apply={job}
        applying={state === "applying"}
        blocked={blocked}
        autoRun={
          state === "auto" && p
            ? {
                at: p.at,
                state: "done",
                added: 31,
                failed: 1,
                held: ["anilist:1", "mal:5", "movie:tmdb:1"],
                notes: ["MyAnimeList: not connected"],
              }
            : null
        }
      />
    </div>
  );
}

/** A mock apply of the preview at `planAt`: part way, or finished with MAL stopped
 * (`auto`: the same, as the automatic run). */
function applyJob(planAt: number, state: "applying" | "applied" | "auto"): ApplyJob {
  const done = state !== "applying";
  return {
    ...(state === "auto" ? { auto: true } : {}),
    v: APPLY_JOB_VERSION,
    state: done ? "done" : "running",
    startedAt: planAt + 30_000,
    beatAt: planAt + 50_000,
    planAt,
    trackers: [
      {
        tracker: "trakt",
        state: "done",
        total: 14,
        done: 13,
        changed: 0,
        failedCount: 1,
        failed: [{ title: "Attack on Titan", error: "Trakt could not match it." }],
      },
      {
        tracker: "anilist",
        state: done ? "done" : "running",
        total: 6,
        done: done ? 5 : 2,
        changed: done ? 1 : 0,
        failedCount: 0,
        failed: [],
      },
      {
        tracker: "mal",
        state: done ? "stopped" : "running",
        total: 8,
        done: done ? 4 : 1,
        changed: 0,
        failedCount: done ? 1 : 0,
        failed: done
          ? [{ title: "Akira", error: "MyAnimeList is limiting requests, try again later" }]
          : [],
        error: done
          ? "MyAnimeList is limiting requests. Preview again later to finish."
          : undefined,
      },
      {
        tracker: "simkl",
        state: done ? "done" : "waiting",
        total: 9,
        done: done ? 9 : 0,
        changed: 0,
        failedCount: 0,
        failed: [],
      },
    ],
  };
}
