/** List sync states for the gallery, with mock lists run through the REAL planner,
 * so the tiles show what the pane renders, not a hand-written imitation. */
import { planSync, summarize, syncKindsFor } from "@/lib/sync/plan";
import type { SyncPreview } from "@/lib/sync/run";
import { DEFAULT_SYNC_SETTINGS, type ListEntry, type ListSyncSettings } from "@/lib/sync/types";
import { Animap } from "@/lib/trackers/animap/index";
import { ALL_TRACKERS, type Tracker } from "@/lib/trackers/types";
import { ListSyncView } from "@/lib/ui/kit/ListSyncView";
import { type Variant, tokens } from "@/lib/ui/kit/kit";
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
];

function preview(settings: ListSyncSettings, trackers: Tracker[]): SyncPreview {
  const plan = planSync({ entries, trackers, settings, animap, scales: { anilist: "POINT_100" } });
  return {
    at: Date.UTC(2026, 8, 28, 9, 30),
    reads: ALL_TRACKERS.map((tracker) =>
      trackers.includes(tracker)
        ? {
            tracker,
            state: "read" as const,
            count: entries.filter((e) => e.tracker === tracker).length,
          }
        : { tracker, state: "not_connected" as const },
    ),
    totals: summarize(plan, trackers),
    plan,
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
}: { variant: Variant; state: "idle" | "preview" | "no-simkl-anime" | "too-few" | "reading" }) {
  const t = tokens(variant);
  const settings: ListSyncSettings =
    state === "no-simkl-anime"
      ? { ...DEFAULT_SYNC_SETTINGS, kinds: { simkl: ["movie", "tv"] }, ignore: ["movie:tmdb:1"] }
      : DEFAULT_SYNC_SETTINGS;
  const p =
    state === "preview" || state === "no-simkl-anime"
      ? preview(settings, ALL_TRACKERS)
      : state === "too-few"
        ? {
            ...preview(settings, ["trakt"]),
            reason: "too_few" as const,
            totals: [],
            plan: { items: [], skips: [], conflicts: [] },
          }
        : null;
  return (
    <div class={clsx("w-full max-w-xl rounded-xl p-5", t.page)}>
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
        onIgnore={noop}
        onClearIgnored={noop}
      />
    </div>
  );
}
