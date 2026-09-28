import { describe, expect, it } from "vitest";
import { APPLY_FRESH_MS, APPLY_JOB_VERSION, type ApplyJob, applyBlock, applyQueues } from "./apply";
import type { SyncPreview } from "./run";
import type { SyncPlan, SyncWrite } from "./types";

const target = { ids: { tmdb: 1 }, mediaType: "show" as const };
const ep: SyncWrite = { tracker: "trakt", op: "episodes", target, add: [{ season: 1, number: 1 }] };
const rate = (tracker: "trakt" | "simkl", score: number): SyncWrite => ({
  tracker,
  op: "rating",
  level: "show",
  target,
  score,
});

const plan: SyncPlan = {
  items: [
    { key: "tv:tmdb:1", kind: "tv", title: "One", writes: [ep, rate("simkl", 80)] },
    {
      key: "tv:tmdb:2",
      kind: "tv",
      title: "Two",
      writes: [{ ...ep, target: { ...target, ids: { tmdb: 2 } } }],
    },
  ],
  skips: [],
  conflicts: [],
  notices: [],
};
const preview: SyncPreview = { at: 1_000, reads: [], totals: [], plan, scales: {} };
const job = (planAt: number, state: ApplyJob["state"] = "done"): ApplyJob => ({
  v: APPLY_JOB_VERSION,
  state,
  startedAt: 2_000,
  beatAt: 2_000,
  planAt,
  trackers: [],
});

describe("applyQueues", () => {
  it("splits the plan per tracker, in plan order, with the item's title", () => {
    const q = applyQueues(preview, [], {});
    expect(q.get("trakt")?.map((x) => x.title)).toEqual(["One", "Two"]);
    expect(q.get("simkl")).toEqual([{ w: rate("simkl", 80), title: "One" }]);
  });

  it("leaves out the items the user keeps out", () => {
    expect(applyQueues(preview, ["tv:tmdb:1"], {}).get("simkl")).toBeUndefined();
  });

  it("puts the user's rating picks in", () => {
    const withConflict: SyncPreview = {
      ...preview,
      plan: {
        ...plan,
        conflicts: [
          {
            key: "tv:tmdb:1",
            title: "One",
            kind: "tv",
            field: "rating",
            values: [
              { tracker: "trakt", value: 60 },
              { tracker: "simkl", value: 90 },
            ],
            chosen: null,
            refs: [
              { tracker: "trakt", level: "show", target },
              { tracker: "simkl", level: "show", target },
            ],
          },
        ],
      },
    };
    const q = applyQueues(withConflict, [], { "rating:tv:tmdb:1": 90 });
    expect(q.get("trakt")?.map((x) => x.w)).toContainEqual(
      expect.objectContaining({ op: "rating", score: 90, picked: true }),
    );
    // Simkl already has 90: its planned fill is replaced by nothing.
    expect(q.get("simkl")).toBeUndefined();
  });
});

describe("applyBlock", () => {
  const queues = applyQueues(preview, [], {});
  it("lets a fresh preview be applied once", () => {
    expect(applyBlock(preview, null, queues, 1_000 + 60_000)).toBeNull();
    expect(applyBlock(preview, job(1_000), queues, 1_000 + 60_000)).toBe("spent");
    // An apply of an older preview does not spend this one.
    expect(applyBlock(preview, job(500), queues, 1_000 + 60_000)).toBeNull();
  });

  it("asks for a new preview when this one is old", () => {
    expect(applyBlock(preview, null, queues, 1_000 + APPLY_FRESH_MS + 1)).toBe("stale");
  });

  it("refuses while an apply runs, with no plan, or with nothing to write", () => {
    expect(applyBlock(preview, job(500, "running"), queues, 2_500)).toBe("running");
    expect(applyBlock(null, null, queues, 0)).toBe("no_plan");
    expect(applyBlock({ ...preview, reason: "too_few" }, null, queues, 1_000)).toBe("no_plan");
    expect(applyBlock(preview, null, new Map(), 1_000)).toBe("nothing");
  });
});
