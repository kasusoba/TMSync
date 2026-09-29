import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import type { ListEntry } from "./types";

// Only Trakt has a list here, so every preview reads one list (too few to plan).
const { readList } = vi.hoisted(() => ({ readList: vi.fn() }));
vi.mock("../trackers/service", () => ({
  getService: (tk: string) => (tk === "trakt" ? { readList } : {}),
}));
vi.mock("../trackers/index", () => ({
  getAdapter: () => ({ isConnected: async () => true }),
}));

import { listSyncApply, listSyncBase, listSyncCache, listSyncJob } from "../storage";
import { startApply } from "./apply";
import { BASE_VERSION } from "./base";
import { commitBase, forgetLists, savePending } from "./base-store";
import { SYNC_JOB_VERSION, type SyncPreview, beginPreview } from "./preview";

const entry = (n: number): ListEntry =>
  ({ tracker: "trakt", kind: "movie", ids: { tmdb: n }, title: String(n) }) as unknown as ListEntry;

const target = { ids: { tmdb: 1 }, mediaType: "movie" as const };
const preview = (): SyncPreview => ({
  at: Date.now(),
  readAt: Date.now(),
  reads: [],
  totals: [],
  scales: {},
  plan: {
    items: [
      {
        key: "movie:tmdb:1",
        kind: "movie",
        title: "One",
        writes: [{ tracker: "trakt", op: "movie", target }],
      },
    ],
    skips: [],
    conflicts: [],
    notices: [],
  },
});

beforeEach(() => {
  fakeBrowser.reset();
  readList.mockReset();
  readList.mockResolvedValue({ entries: [] });
});

describe("beginPreview", () => {
  it("starts one job when two starts come at the same moment", async () => {
    const [a, b] = await Promise.all([beginPreview(true), beginPreview(false)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await (a ?? b);
    expect(readList).toHaveBeenCalledTimes(1);
  });

  it("takes a list too long to spread into one call", async () => {
    const long = Array.from({ length: 300_000 }, (_, n) => entry(n));
    readList.mockResolvedValue({ entries: long });
    const job = await await beginPreview(false);
    expect(job?.state).toBe("done");
    expect(job?.reads.find((r) => r.tracker === "trakt")).toMatchObject({
      state: "read",
      count: 300_000,
    });
  });
});

describe("an account change during a preview", () => {
  it("drops the list read from the old account, and does not save it", async () => {
    readList.mockImplementation(async () => {
      await forgetLists("trakt");
      return { entries: [entry(1)], cache: { v: 1 } };
    });
    const job = await await beginPreview(false);
    expect(job?.reads.find((r) => r.tracker === "trakt")?.state).toBe("failed");
    expect(await listSyncCache("trakt").getValue()).toBeNull();
  });

  it("never makes the old account's list the base", async () => {
    const readAt = Date.now();
    await savePending(1, readAt, "", { trakt: [{ k: ["movie:tmdb:1"] }], simkl: [] });
    await forgetLists("trakt");
    await commitBase(1, []);
    expect((await listSyncBase.getValue())?.trackers).toEqual({ simkl: [] });
  });
});

describe("startApply", () => {
  const seed = () =>
    listSyncJob.setValue({
      v: SYNC_JOB_VERSION,
      state: "done",
      startedAt: 0,
      beatAt: 0,
      reads: [],
      preview: preview(),
    });

  it("starts one apply when two starts come at the same moment", async () => {
    await seed();
    const out = await Promise.all([startApply(), startApply()]);
    expect(out.filter((o) => o.started)).toHaveLength(1);
    expect(out.find((o) => !o.started)?.reason).toBe("running");
  });

  it("refuses a plan read from an account that changed since", async () => {
    await listSyncJob.setValue({
      v: SYNC_JOB_VERSION,
      state: "done",
      startedAt: 0,
      beatAt: 0,
      reads: [],
      preview: { ...preview(), reads: [{ tracker: "trakt", state: "read", count: 1 }] },
    });
    await forgetLists("trakt");
    expect(await startApply()).toEqual({ started: false, reason: "stale" });
  });

  it("rejects when the job cannot be saved, instead of dropping the error", async () => {
    await seed();
    vi.spyOn(listSyncApply, "setValue").mockRejectedValueOnce(new Error("quota"));
    await expect(startApply()).rejects.toThrow("quota");
  });

  it("an apply cannot start while a preview is claimed", async () => {
    await seed();
    const [p, a] = await Promise.all([beginPreview(false), startApply()]);
    // Whichever came first holds the lock; the other sees it running.
    if (p) expect(a).toEqual({ started: false, reason: "previewing" });
    else expect(a.started).toBe(true);
    await p;
  });
});

describe("forgetLists", () => {
  it("never throws, so an account can still disconnect", async () => {
    await listSyncBase.setValue({ v: BASE_VERSION, at: 0, sig: "", trackers: { trakt: [] } });
    vi.spyOn(listSyncCache("trakt"), "removeValue").mockRejectedValueOnce(new Error("io"));
    vi.spyOn(listSyncBase, "setValue").mockRejectedValueOnce(new Error("io"));
    await expect(forgetLists("trakt")).resolves.toBeUndefined();
  });
});
