import { describe, expect, it } from "vitest";
import { malFields } from "./apply";

describe("malFields", () => {
  it("maps a cour status, count, and score to MAL's fields", () => {
    expect(malFields({ status: "PAUSED", progress: 4, score: 76 })).toEqual({
      status: "on_hold",
      num_watched_episodes: 4,
      score: 8,
    });
    expect(malFields({ status: "PLANNING" })).toEqual({ status: "plan_to_watch" });
    expect(malFields({ repeat: 2 })).toEqual({ num_times_rewatched: 2 });
  });

  it("writes a rewatch as a completed entry with the flag", () => {
    expect(malFields({ status: "REPEATING" })).toEqual({
      status: "completed",
      is_rewatching: true,
    });
  });
});
