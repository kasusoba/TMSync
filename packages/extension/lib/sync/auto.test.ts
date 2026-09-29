import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import type { SyncPlan, SyncWrite } from "./types";

const { beginPreview, beginApply } = vi.hoisted(() => ({
  beginPreview: vi.fn(),
  beginApply: vi.fn(),
}));
vi.mock("./preview", async (orig) => ({
  ...(await orig<typeof import("./preview")>()),
  beginPreview,
}));
vi.mock("./apply", async (orig) => ({ ...(await orig<typeof import("./apply")>()), beginApply }));

import { listSyncApply, listSyncAuto, listSyncJob, listSyncSettings } from "../storage";
import { APPLY_FRESH_MS, APPLY_JOB_VERSION } from "./apply";
import { AUTO_GAP_MS, additionsOnly, previewWaiting, runAuto, unseen } from "./auto";
import { SYNC_JOB_VERSION, type SyncJob } from "./preview";
import { DEFAULT_SYNC_SETTINGS } from "./types";

const target = { id: 1, ids: {}, mediaType: "show" as const, anime: true };
const plan = (
  key: string,
  writes: SyncWrite[],
  conflicts: SyncPlan["conflicts"] = [],
): SyncPlan => ({
  items: [{ key, kind: "anime", title: key, writes }],
  skips: [],
  conflicts,
  notices: [],
});
const entry = (w: Partial<Extract<SyncWrite, { op: "entry" }>>): SyncWrite => ({
  tracker: "anilist",
  op: "entry",
  target,
  create: false,
  ...w,
});

describe("additionsOnly", () => {
  it("keeps episodes, movies, rating fills, and new entries", () => {
    const writes: SyncWrite[] = [
      { tracker: "trakt", op: "episodes", target, add: [{ season: 1, number: 2 }] },
      { tracker: "trakt", op: "movie", target },
      { tracker: "mal", op: "rating", level: "entry", target, score: 80 },
      entry({ create: true, progress: { from: 0, to: 3 }, status: { from: null, to: "CURRENT" } }),
    ];
    const out = additionsOnly(plan("a", writes));
    expect(out.plan.items[0]?.writes).toEqual(writes);
    expect(out.held).toEqual([]);
  });

  it("holds removals and picked scores", () => {
    const out = additionsOnly(
      plan("a", [
        { tracker: "mal", op: "remove", target, was: {} },
        { tracker: "mal", op: "rating", level: "entry", target, score: 80, picked: true },
      ]),
    );
    expect(out.plan.items).toEqual([]);
    expect(out.held).toEqual(["a"]);
  });

  it("keeps the status progress brings, and holds a status change alone", () => {
    const up = entry({
      progress: { from: 2, to: 12 },
      status: { from: "CURRENT", to: "COMPLETED" },
    });
    expect(additionsOnly(plan("a", [up])).plan.items[0]?.writes).toEqual([up]);

    const only = entry({ status: { from: "CURRENT", to: "DROPPED" } });
    const held = additionsOnly(plan("b", [only]));
    expect(held.plan.items).toEqual([]);
    expect(held.held).toEqual(["b"]);

    // Progress up with a status the progress does not bring: the progress goes in.
    const mixed = entry({
      progress: { from: 2, to: 4 },
      status: { from: "CURRENT", to: "PAUSED" },
    });
    const part = additionsOnly(plan("c", [mixed]));
    expect(part.plan.items[0]?.writes).toEqual([entry({ progress: { from: 2, to: 4 } })]);
    expect(part.held).toEqual(["c"]);
  });

  it("holds a new entry whose status the trackers disagree on, and every conflict", () => {
    const create = entry({ create: true, status: { from: null, to: "DROPPED" } });
    const conflict = {
      key: "a",
      title: "a",
      kind: "anime" as const,
      field: "status" as const,
      values: [],
      chosen: null,
    };
    const out = additionsOnly(plan("a", [create], [conflict]));
    expect(out.plan.items).toEqual([]);
    expect(out.held).toEqual(["a"]);
  });
});

describe("unseen", () => {
  it("counts held items not seen yet", () => {
    const run = { at: 0, state: "done" as const, added: 0, failed: 0, held: ["a", "b"], notes: [] };
    expect(unseen(run, ["a"])).toBe(1);
    expect(unseen(null, [])).toBe(0);
  });
});

describe("previewWaiting", () => {
  const job = (p: Partial<NonNullable<SyncJob["preview"]>> = {}): SyncJob => ({
    v: SYNC_JOB_VERSION,
    state: "done",
    startedAt: 0,
    beatAt: 0,
    reads: [],
    preview: {
      at: 1_000,
      reads: [],
      totals: [],
      scales: {},
      plan: plan("a", [{ tracker: "trakt", op: "movie", target }]),
      ...p,
    },
  });
  const applied = (planAt: number) => ({
    v: APPLY_JOB_VERSION,
    state: "done" as const,
    startedAt: 0,
    beatAt: 0,
    planAt,
    trackers: [],
  });

  it("a fresh preview made by hand, not applied yet, waits", () => {
    expect(previewWaiting(job(), null, 1_000 + APPLY_FRESH_MS)).toBe(true);
  });
  it("a stale, applied, automatic, or empty preview does not", () => {
    expect(previewWaiting(job(), null, 1_001 + APPLY_FRESH_MS)).toBe(false);
    expect(previewWaiting(job(), applied(1_000), 1_000)).toBe(false);
    expect(previewWaiting(job({ auto: true }), null, 1_000)).toBe(false);
    expect(previewWaiting(job({ plan: { ...plan("a", []), items: [] } }), null, 1_000)).toBe(false);
    expect(previewWaiting(null, null, 1_000)).toBe(false);
  });
});

describe("runAuto", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    beginPreview.mockReset();
    beginApply.mockReset();
  });

  it("does nothing while auto sync is off", async () => {
    await runAuto();
    expect(beginPreview).not.toHaveBeenCalled();
  });

  it("runs at most once in a day", async () => {
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: true });
    await listSyncAuto.setValue({
      at: Date.now() - AUTO_GAP_MS / 2,
      state: "done",
      added: 0,
      failed: 0,
      held: [],
      notes: [],
    });
    await runAuto();
    expect(beginPreview).not.toHaveBeenCalled();
  });

  it("applies only the additions and saves what waits", async () => {
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: true });
    const preview = {
      at: Date.now(),
      reads: [{ tracker: "mal", state: "not_connected" }],
      totals: [],
      scales: {},
      plan: plan("a", [
        { tracker: "trakt", op: "movie", target },
        { tracker: "simkl", op: "remove", target, was: {} },
      ]),
    };
    beginPreview.mockResolvedValue(
      Promise.resolve({ state: "done", reads: preview.reads, preview }),
    );
    beginApply.mockResolvedValue({
      state: "done",
      trackers: [{ tracker: "trakt", done: 1, failedCount: 0 }],
    });
    await runAuto();
    expect(beginPreview).toHaveBeenCalledWith(true);
    const queues = beginApply.mock.calls[0]?.[1] as Map<string, { w: SyncWrite }[]>;
    expect([...queues.keys()]).toEqual(["trakt"]);
    // A removal was held, so this run must not move the base.
    expect(beginApply.mock.calls[0]?.[3]).toBe(false);
    const run = await listSyncAuto.getValue();
    expect(run).toMatchObject({ state: "done", added: 1, held: ["a"] });
    expect(run?.notes).toEqual(["MyAnimeList: not connected"]);
  });

  it("is skipped while a preview made by hand waits to be applied", async () => {
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: true });
    await listSyncJob.setValue({
      v: SYNC_JOB_VERSION,
      state: "done",
      startedAt: 0,
      beatAt: 0,
      reads: [],
      preview: {
        at: Date.now(),
        reads: [],
        totals: [],
        scales: {},
        plan: plan("a", [{ tracker: "trakt", op: "movie", target }]),
      },
    });
    await listSyncApply.setValue(null);
    await runAuto();
    expect(beginPreview).not.toHaveBeenCalled();
    expect(await listSyncAuto.getValue()).toMatchObject({
      state: "skipped",
      notes: ["A preview was waiting."],
    });
  });

  it("is skipped when the apply cannot start", async () => {
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: true });
    const preview = {
      at: Date.now(),
      reads: [],
      totals: [],
      scales: {},
      plan: plan("a", [{ tracker: "trakt", op: "movie", target }]),
    };
    beginPreview.mockResolvedValue(Promise.resolve({ state: "done", reads: [], preview }));
    beginApply.mockResolvedValue(null);
    await runAuto();
    expect((await listSyncAuto.getValue())?.state).toBe("skipped");
  });

  it("is skipped while the user's own sync runs", async () => {
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: true });
    beginPreview.mockResolvedValue(null);
    await runAuto();
    expect((await listSyncAuto.getValue())?.state).toBe("skipped");
  });
});
