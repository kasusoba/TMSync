import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListCache } from "../../sync/cache";

const { readTraktActivity, readTraktList } = vi.hoisted(() => ({
  readTraktActivity: vi.fn(),
  readTraktList: vi.fn(),
}));
vi.mock("./client", async (orig) => ({
  ...(await orig<typeof import("./client")>()),
  readTraktActivity,
  readTraktList,
}));

import { readTraktEntries } from "./list";

const dump = (movies: number[], shows: number[]) => ({
  shows: shows.map((id) => ({
    show: { title: `s${id}`, ids: { trakt: id } },
    seasons: [{ number: 1, episodes: [{ number: 1 }] }],
  })),
  movies: movies.map((id) => ({ movie: { title: `m${id}`, ids: { trakt: id } } })),
  showRatings: [],
  seasonRatings: [],
  movieRatings: [],
});

beforeEach(() => {
  readTraktActivity.mockReset();
  readTraktList.mockReset();
});

describe("readTraktEntries", () => {
  it("reuses the saved list while the stamp does not move", async () => {
    readTraktActivity.mockResolvedValue({ all: "t1" });
    readTraktList.mockResolvedValue(dump([1], [2]));
    const first = await readTraktEntries(["movie", "tv"], null);
    expect(first.from).toBeUndefined();
    const saved = first.cache as ListCache;
    expect(saved.stamps).toEqual({ shows: "t1", movies: "t1" });

    readTraktList.mockClear();
    const same = await readTraktEntries(["movie", "tv"], saved);
    expect(readTraktList).not.toHaveBeenCalled();
    expect(same.from).toBe("saved");
    expect(same.entries.map((e) => e.id).sort()).toEqual([1, 2]);

    readTraktActivity.mockResolvedValue({ all: "t2" });
    readTraktList.mockResolvedValue(dump([1, 3], [2]));
    const moved = await readTraktEntries(["movie", "tv"], saved);
    expect(readTraktList).toHaveBeenLastCalledWith({ shows: true, movies: true });
    expect(moved.from).toBeUndefined();
    expect(moved.entries).toHaveLength(3);
  });

  it("reads only a part the saved list does not cover", async () => {
    readTraktActivity.mockResolvedValue({ all: "t1" });
    readTraktList.mockResolvedValue(dump([1], []));
    const saved = (await readTraktEntries(["movie"], null)).cache as ListCache;
    readTraktList.mockResolvedValue(dump([], [2]));
    const out = await readTraktEntries(["movie", "tv"], saved);
    expect(readTraktList).toHaveBeenLastCalledWith({ shows: true, movies: false });
    expect(out.from).toBe("changes");
    expect(out.entries.map((e) => e.id).sort()).toEqual([1, 2]);
  });

  it("reads in full when the stamp cannot be read", async () => {
    readTraktActivity.mockRejectedValue(new Error("Trakt 503"));
    readTraktList.mockResolvedValue(dump([1], []));
    const out = await readTraktEntries(["movie"], null);
    expect(out.entries).toHaveLength(1);
    expect(out.cache?.stamps).toEqual({});
  });
});
