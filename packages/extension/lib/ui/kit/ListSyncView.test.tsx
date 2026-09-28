import { render } from "preact";
import { describe, expect, it } from "vitest";
import { planSync, summarize, syncKindsFor } from "../../sync/plan";
import type { SyncPreview } from "../../sync/run";
import { DEFAULT_SYNC_SETTINGS, type ListEntry, type ListSyncSettings } from "../../sync/types";
import { Animap } from "../../trackers/animap/index";
import { ALL_TRACKERS, type Tracker } from "../../trackers/types";
import { ListSyncView } from "./ListSyncView";
import { tokens } from "./kit";

// A render smoke test: a crash in this view blanks the whole options pane.
const entries: ListEntry[] = [
  {
    tracker: "mal",
    shape: "cour",
    id: 47,
    title: "Akira",
    ids: { mal: 47 },
    rating: null,
    progress: 0,
    total: 1,
    status: "PLANNING",
    repeat: 0,
    movie: true,
  },
  {
    tracker: "anilist",
    shape: "cour",
    id: 30,
    title: "Show",
    ids: { anilist: 30, mal: 300 },
    rating: 80,
    progress: 3,
    total: 12,
    status: "CURRENT",
    repeat: 0,
  },
  {
    tracker: "mal",
    shape: "cour",
    id: 300,
    title: "Show",
    ids: { mal: 300 },
    rating: 50,
    progress: 9,
    total: 12,
    status: "CURRENT",
    repeat: 0,
  },
  {
    tracker: "trakt",
    shape: "seasons",
    id: 1,
    title: "Severance",
    ids: { tmdb: 95396 },
    rating: null,
    seasons: { 1: [1, 2] },
  },
];

function show(settings: ListSyncSettings): string {
  const trackers: Tracker[] = ["trakt", "anilist", "mal", "simkl"];
  const plan = planSync({
    entries,
    trackers,
    settings,
    animap: new Animap([{ a: 30, m: 300, t: 50, k: "tv", s: 1 }]),
  });
  const preview: SyncPreview = {
    at: 0,
    reads: ALL_TRACKERS.map((tracker) => ({ tracker, state: "read", count: 1 })),
    totals: summarize(plan, trackers),
    plan,
  };
  const root = document.createElement("div");
  render(
    <ListSyncView
      t={tokens("dark")}
      rows={ALL_TRACKERS.map((tk) => ({
        tracker: tk,
        can: syncKindsFor(tk),
        on: syncKindsFor(tk),
      }))}
      settings={settings}
      preview={preview}
      busy={false}
      onPreview={() => {}}
      onKind={() => {}}
      onSetting={() => {}}
      onMain={() => {}}
      onIgnore={() => {}}
      onRestore={() => {}}
      onClearIgnored={() => {}}
    />,
    root,
  );
  return root.textContent ?? "";
}

describe("ListSyncView", () => {
  it("renders a union preview", () => {
    const text = show(DEFAULT_SYNC_SETTINGS);
    expect(text).toContain("Changes");
    expect(text).toContain("Severance");
  });

  it("renders a main-list preview with removals and notices", () => {
    const text = show({ ...DEFAULT_SYNC_SETTINGS, main: { anime: "anilist" }, ignore: ["x"] });
    expect(text).toContain("Removals");
    expect(text).toContain("Left as is");
  });
});
