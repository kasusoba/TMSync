import { describe, expect, it } from "vitest";
import { LIST_CACHE_VERSION, mergeById, newCache, readFrom, savedParts } from "./list-cache";
import type { ListEntry } from "./types";

const movie = (id: number, watched = true): ListEntry => ({
  tracker: "trakt",
  shape: "movie",
  id,
  title: `m${id}`,
  ids: {},
  rating: null,
  watched,
});
const show = (id: number): ListEntry => ({
  tracker: "trakt",
  shape: "seasons",
  id,
  title: `s${id}`,
  ids: {},
  rating: null,
  seasons: { 1: [1] },
});
const part = (e: ListEntry) => (e.shape === "movie" ? "movies" : "shows");

describe("savedParts", () => {
  it("splits a saved list by part", () => {
    const parts = savedParts(newCache({}, [movie(1), show(2), movie(3)], 0), part);
    expect(parts?.get("movies")?.map((e) => e.id)).toEqual([1, 3]);
    expect(parts?.get("shows")?.map((e) => e.id)).toEqual([2]);
  });

  it("drops a list from an older build", () => {
    const old = { ...newCache({}, [movie(1)], 0), v: LIST_CACHE_VERSION - 1 };
    expect(savedParts(old, part)).toBeNull();
    expect(savedParts(null, part)).toBeNull();
  });
});

describe("mergeById", () => {
  it("replaces changed entries and adds new ones", () => {
    const out = mergeById([movie(1, false), movie(2)], [movie(1, true), movie(3)]);
    expect(out.map((e) => [e.id, e.shape === "movie" && e.watched])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
  });
});

describe("newCache", () => {
  it("leaves out missing stamps, so that part is read in full next time", () => {
    expect(newCache({ shows: "a", movies: null, anime: undefined }, [], 5).stamps).toEqual({
      shows: "a",
    });
  });
});

describe("readFrom", () => {
  it("names how much was read", () => {
    expect(readFrom({ saved: 2, changes: 0, full: 0 })).toBe("saved");
    expect(readFrom({ saved: 1, changes: 0, full: 1 })).toBe("changes");
    expect(readFrom({ saved: 0, changes: 1, full: 0 })).toBe("changes");
    expect(readFrom({ saved: 0, changes: 0, full: 2 })).toBeUndefined();
  });
});
