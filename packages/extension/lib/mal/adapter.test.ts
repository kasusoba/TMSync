import { describe, expect, it } from "vitest";
import { planToFields } from "./adapter";

describe("planToFields", () => {
  it("writes a first watch as watching", () => {
    expect(
      planToFields({ kind: "write", progress: 3, status: "CURRENT", completed: false }),
    ).toEqual({ status: "watching", num_watched_episodes: 3 });
  });

  it("completes the entry and clears any rewatch flag", () => {
    expect(
      planToFields({ kind: "write", progress: 12, status: "COMPLETED", completed: true }),
    ).toEqual({ status: "completed", is_rewatching: false, num_watched_episodes: 12 });
  });

  it("marks a rewatch as completed + is_rewatching (MAL has no REPEATING status)", () => {
    expect(
      planToFields({ kind: "write", progress: 2, status: "REPEATING", completed: false }),
    ).toEqual({ status: "completed", is_rewatching: true, num_watched_episodes: 2 });
  });

  it("bumps the rewatch count when a rewatch finishes", () => {
    expect(
      planToFields({
        kind: "write",
        progress: 12,
        status: "COMPLETED",
        repeat: 1,
        completed: true,
      }),
    ).toEqual({
      status: "completed",
      is_rewatching: false,
      num_watched_episodes: 12,
      num_times_rewatched: 1,
    });
  });
});
