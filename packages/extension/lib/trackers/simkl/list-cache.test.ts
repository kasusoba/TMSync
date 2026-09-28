import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListCache } from "../../sync/cache";

const { readSimklActivity, readSimklList } = vi.hoisted(() => ({
  readSimklActivity: vi.fn(),
  readSimklList: vi.fn(),
}));
vi.mock("./client", async (orig) => ({
  ...(await orig<typeof import("./client")>()),
  readSimklActivity,
  readSimklList,
}));

import { readSimklEntries, simklReadPlan, simklStamps } from "./list";

const anime = (id: number, watched: number) => ({
  status: "watching",
  watched_episodes_count: watched,
  total_episodes_count: 12,
  show: { title: `a${id}`, ids: { simkl: id } },
});
const movie = (id: number) => ({
  status: "completed",
  movie: { title: `m${id}`, ids: { simkl: id } },
});

const activity = (anime: string, removed: string | null, movies = "m1") => ({
  all: "x",
  tv_shows: { all: null, removed_from_list: null },
  anime: { all: anime, removed_from_list: removed },
  movies: { all: movies, removed_from_list: null },
});

beforeEach(() => {
  readSimklActivity.mockReset();
  readSimklList.mockReset();
});

describe("simklStamps", () => {
  it("reads each type's stamps", () => {
    expect(simklStamps(activity("a1", "r1"))).toEqual({
      shows: { all: null, removed: null },
      anime: { all: "a1", removed: "r1" },
      movies: { all: "m1", removed: null },
    });
    expect(simklStamps("nonsense")).toEqual({});
  });
});

describe("simklReadPlan", () => {
  const saved = { anime: "a1", "anime:removed": "r1", movies: "m1" };
  it("reuses, reads changes, or reads in full", () => {
    expect(simklReadPlan(["anime"], { anime: { all: "a1", removed: "r1" } }, saved)).toEqual({
      anime: "saved",
    });
    expect(simklReadPlan(["anime"], { anime: { all: "a2", removed: "r1" } }, saved)).toEqual({
      anime: "changes",
    });
    // Something left the library: a delta would not say what, so read it all.
    expect(simklReadPlan(["anime"], { anime: { all: "a2", removed: "r2" } }, saved)).toEqual({
      anime: "full",
    });
    // No saved stamp, or no stamp now.
    expect(simklReadPlan(["shows"], { shows: { all: "s1" } }, saved)).toEqual({ shows: "full" });
    expect(simklReadPlan(["anime"], {}, saved)).toEqual({ anime: "full" });
    expect(simklReadPlan(["anime"], { anime: { all: "a1" } }, null)).toEqual({ anime: "full" });
    // Never any activity: the type is empty, nothing to read.
    expect(simklReadPlan(["shows"], { shows: { all: null } }, null)).toEqual({ shows: "empty" });
  });
});

describe("readSimklEntries", () => {
  it("reads in full first, then reuses, then reads only the changes", async () => {
    readSimklActivity.mockResolvedValue(activity("a1", null));
    readSimklList.mockResolvedValue({ anime: [anime(1, 3), anime(2, 5)], movies: [movie(9)] });
    const first = await readSimklEntries(["anime", "movie"], null);
    // Shows never had any activity, so they are not read.
    expect(readSimklList).toHaveBeenLastCalledWith(["anime", "movies"], {});
    expect(first.from).toBeUndefined();
    const saved = first.cache as ListCache;
    expect(saved.stamps).toEqual({ anime: "a1", movies: "m1" });

    // Nothing moved: only the activity call.
    readSimklList.mockClear();
    const second = await readSimklEntries(["anime", "movie"], saved);
    expect(readSimklList).not.toHaveBeenCalled();
    expect(second.from).toBe("saved");
    expect(second.entries).toHaveLength(3);

    // Anime moved, nothing removed: a delta from the saved stamp, laid over.
    readSimklActivity.mockResolvedValue(activity("a2", null));
    readSimklList.mockResolvedValue({ anime: [anime(1, 4)] });
    const third = await readSimklEntries(["anime", "movie"], saved);
    expect(readSimklList).toHaveBeenLastCalledWith(["anime"], { anime: "a1" });
    expect(third.from).toBe("changes");
    const progress = third.entries
      .filter((e) => e.shape === "cour")
      .map((e) => [e.id, e.shape === "cour" && e.progress]);
    expect(progress).toEqual([
      [1, 4],
      [2, 5],
    ]);
    expect(third.cache?.stamps.anime).toBe("a2");
  });

  it("reads in full when the activity check fails, and saves no stamps", async () => {
    readSimklActivity.mockRejectedValue(new Error("Simkl 500"));
    readSimklList.mockResolvedValue({ movies: [movie(9)] });
    const out = await readSimklEntries(["movie"], null);
    expect(out.entries).toHaveLength(1);
    expect(out.cache?.stamps).toEqual({});
  });
});
