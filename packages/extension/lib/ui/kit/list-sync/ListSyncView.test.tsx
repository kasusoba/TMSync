import { render } from "preact";
import { describe, expect, it } from "vitest";
import { planSync, summarize, syncKindsFor } from "../../../sync/plan/index";
import type { SyncPreview } from "../../../sync/preview";
import { DEFAULT_SYNC_SETTINGS, type ListEntry, type ListSyncSettings } from "../../../sync/types";
import { Animap } from "../../../trackers/animap/index";
import { ALL_TRACKERS, type Tracker } from "../../../trackers/types";
import { tokens } from "../kit";
import { ListSyncView } from "./ListSyncView";

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

function show(
  settings: ListSyncSettings,
  extra: Partial<Parameters<typeof ListSyncView>[0]> = {},
  auto = false,
): string {
  const trackers: Tracker[] = ["trakt", "anilist", "mal", "simkl"];
  const plan = planSync({
    entries,
    trackers,
    settings,
    animap: new Animap([{ a: 30, m: 300, t: 50, k: "tv", s: 1 }]),
  });
  const preview: SyncPreview = {
    at: 0,
    readAt: 0,
    reads: ALL_TRACKERS.map((tracker) => ({ tracker, state: "read", count: 1 })),
    totals: summarize(plan, trackers),
    plan,
    scales: {},
    ...(auto ? { auto: true } : {}),
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
      {...extra}
    />,
    root,
  );
  return root.textContent ?? "";
}

/** The key the planner gives the item titled `title`. */
function plannedKey(title: string): string {
  const trackers: Tracker[] = ["trakt", "anilist", "mal", "simkl"];
  const plan = planSync({
    entries,
    trackers,
    settings: DEFAULT_SYNC_SETTINGS,
    animap: new Animap([{ a: 30, m: 300, t: 50, k: "tv", s: 1 }]),
  });
  return [...plan.items, ...plan.conflicts].find((x) => x.title === title)?.key ?? "";
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
    // The Changes tab says what each tracker had: Simkl gets Severance as new.
    expect(text).toContain("+2 episodes · new");
    expect(text).toContain("Left as is");
  });
});

describe("ListSyncView apply", () => {
  it("offers Apply on a fresh preview", () => {
    expect(show(DEFAULT_SYNC_SETTINGS)).toContain("Apply changes");
  });

  it("offers to review what the daily run held, instead of the old-plan note", () => {
    const run = {
      at: 0,
      state: "done" as const,
      added: 0,
      failed: 0,
      held: [] as string[],
      notes: [],
    };
    const held = show(DEFAULT_SYNC_SETTINGS, { blocked: "stale", autoRun: run }, true);
    expect(held).not.toContain("Review held changes");
    const key = plannedKey("Show");
    const text = show(
      { ...DEFAULT_SYNC_SETTINGS, auto: true },
      { blocked: "stale", autoRun: { ...run, held: [key] } },
      true,
    );
    expect(text).toContain("held 1 change for you");
    expect(text).toContain("Review held changes");
    expect(text).not.toContain("more than 10 minutes old");
    // A daily plan that can still be applied keeps its Apply.
    const fresh0 = show(
      { ...DEFAULT_SYNC_SETTINGS, auto: true },
      { autoRun: { ...run, held: [key] } },
      true,
    );
    expect(fresh0).toContain("Apply changes");
    expect(fresh0).not.toContain("Review held changes");
    // A fresh preview offers the held items as a filter.
    const fresh = show(DEFAULT_SYNC_SETTINGS, { autoRun: { ...run, held: [key] } });
    expect(fresh).toContain("Held by daily sync1");
  });

  it("asks for a new preview when this one is old", () => {
    const text = show(DEFAULT_SYNC_SETTINGS, { blocked: "stale" });
    expect(text).toContain("more than 10 minutes old");
    expect(text).not.toContain("Apply changes");
  });

  it("shows each tracker's progress while applying", () => {
    const text = show(DEFAULT_SYNC_SETTINGS, {
      applying: true,
      apply: {
        v: 1,
        state: "running",
        startedAt: 1,
        beatAt: 1,
        planAt: 0,
        trackers: [
          {
            tracker: "mal",
            state: "running",
            total: 4,
            done: 1,
            changed: 1,
            failedCount: 0,
            failed: [],
          },
        ],
      },
    });
    expect(text).toContain("Applying…");
    expect(text).toContain("1 of 4 written · 1 changed since the preview");
    expect(text).toContain("Stop");
  });
});

describe("ListSyncView daily sync", () => {
  it("says it is off", () => {
    expect(show(DEFAULT_SYNC_SETTINGS)).toContain("Off.");
  });

  it("says when it runs next", () => {
    const text = show({ ...DEFAULT_SYNC_SETTINGS, auto: true }, { autoNow: { next: 1 } });
    expect(text).toContain("On. Next run");
  });

  it("says it runs now, and the preview waits for it", () => {
    const text = show(
      { ...DEFAULT_SYNC_SETTINGS, auto: true },
      { busy: true, autoNow: { running: "reading" } },
    );
    expect(text).toContain("Running now: reading your lists.");
    expect(text).toContain("Waits for the daily sync to finish.");
  });
});
