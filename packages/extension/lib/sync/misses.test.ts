import { describe, expect, it } from "vitest";
import { MISS_TTL_MS, addMisses, dropMissed, liveMisses } from "./misses";
import type { SyncWrite } from "./types";

const target = { ids: { tmdb: 1 }, mediaType: "show" as const };
const eps = (tracker: "simkl" | "trakt", ...n: number[]): SyncWrite => ({
  tracker,
  op: "episodes",
  target,
  add: n.map((number) => ({ season: 1, number })),
});
const rating: SyncWrite = { tracker: "simkl", op: "rating", score: 80, level: "show", target };

describe("misses", () => {
  it("remembers the episodes of an episodes write, and the whole item for others", () => {
    const m = addMisses({}, [{ key: "tv:tmdb:1", w: eps("simkl", 3, 4) }], 10);
    expect(m.simkl?.["tv:tmdb:1"]).toEqual({ at: 10, eps: ["1:3", "1:4"] });
    const n = addMisses(m, [{ key: "tv:tmdb:1", w: rating }], 20);
    expect(n.simkl?.["tv:tmdb:1"]).toEqual({ at: 20, eps: ["1:3", "1:4"], whole: true });
  });

  it("drops only the missed episodes, and says how many", () => {
    const m = addMisses({}, [{ key: "k", w: eps("simkl", 3, 4) }], 0);
    const out = dropMissed("k", "Show", [eps("simkl", 2, 3, 4), eps("trakt", 3)], m);
    expect(out.writes).toEqual([eps("simkl", 2), eps("trakt", 3)]);
    expect(out.skips).toEqual([
      { key: "k", title: "Show", tracker: "simkl", reason: "not_on_tracker", detail: "2 episodes" },
    ]);
  });

  it("drops every write to a tracker that missed the whole item", () => {
    const m = addMisses({}, [{ key: "k", w: rating }], 0);
    const out = dropMissed("k", "Show", [eps("simkl", 1), rating, eps("trakt", 1)], m);
    expect(out.writes).toEqual([eps("trakt", 1)]);
    expect(out.skips).toEqual([
      { key: "k", title: "Show", tracker: "simkl", reason: "not_on_tracker" },
    ]);
  });

  it("forgets a miss after the time to live", () => {
    const m = addMisses({}, [{ key: "k", w: rating }], 0);
    expect(liveMisses(m, MISS_TTL_MS - 1).simkl?.k).toBeDefined();
    expect(liveMisses(m, MISS_TTL_MS)).toEqual({});
  });
});
