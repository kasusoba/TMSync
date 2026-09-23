import { describe, expect, it } from "vitest";
import { type CourEntry, type CourPlanInput, planCourWrite } from "./cour-plan";

const base: CourPlanInput = {
  phase: "stop",
  progress: 90,
  watchedThreshold: 0.8,
  episode: 3,
  total: 12,
  entry: null,
  rewatchConfirmed: false,
};

const entry = (e: Partial<CourEntry>): CourEntry => ({
  status: null,
  progress: 0,
  repeat: 0,
  ...e,
});

describe("planCourWrite: first watch", () => {
  it("sets CURRENT with the episode when not on the list", () => {
    expect(planCourWrite(base)).toEqual({
      kind: "write",
      progress: 3,
      status: "CURRENT",
      completed: false,
    });
  });

  it("marks COMPLETED on the final episode", () => {
    expect(planCourWrite({ ...base, episode: 12 })).toEqual({
      kind: "write",
      progress: 12,
      status: "COMPLETED",
      completed: true,
    });
  });

  it("flips PLANNING/PAUSED/DROPPED to CURRENT and never lowers progress", () => {
    expect(
      planCourWrite({ ...base, episode: 4, entry: entry({ status: "PAUSED", progress: 6 }) }),
    ).toEqual({ kind: "write", progress: 6, status: "CURRENT", completed: false });
  });

  it("reports already-watched when CURRENT and the episode is at/below progress", () => {
    // Won't advance (never lower progress) → surface it, not a silent noop → "stopped".
    expect(
      planCourWrite({ ...base, episode: 3, entry: entry({ status: "CURRENT", progress: 5 }) }),
    ).toEqual({ kind: "already_watched", episode: 3, progress: 5 });
    // The current high-water episode itself is already counted too.
    expect(
      planCourWrite({ ...base, episode: 5, entry: entry({ status: "CURRENT", progress: 5 }) }),
    ).toEqual({ kind: "already_watched", episode: 5, progress: 5 });
  });

  it("surfaces already-watched EARLY (on play), not just at the stop threshold", () => {
    expect(
      planCourWrite({
        ...base,
        phase: "start",
        progress: 1,
        episode: 2,
        entry: entry({ status: "CURRENT", progress: 5 }),
      }),
    ).toEqual({ kind: "already_watched", episode: 2, progress: 5 });
  });

  it("still writes the next NEW episode normally (above progress)", () => {
    expect(
      planCourWrite({ ...base, episode: 6, entry: entry({ status: "CURRENT", progress: 5 }) }),
    ).toEqual({ kind: "write", progress: 6, status: "CURRENT", completed: false });
  });
});

describe("planCourWrite: gates", () => {
  it("does nothing for start/pause", () => {
    expect(planCourWrite({ ...base, phase: "start" })).toEqual({ kind: "noop" });
    expect(planCourWrite({ ...base, phase: "pause" })).toEqual({ kind: "noop" });
  });

  it("does nothing for a stop below the watched threshold", () => {
    expect(planCourWrite({ ...base, progress: 50 })).toEqual({ kind: "noop" });
  });

  it("refuses a no-episode show", () => {
    expect(planCourWrite({ ...base, episode: undefined })).toEqual({ kind: "no_episode" });
  });

  it("flags a numbering mismatch when episode exceeds the entry total (guardrail)", () => {
    expect(planCourWrite({ ...base, episode: 50, total: 12 })).toEqual({
      kind: "mismatch",
      episode: 50,
      total: 12,
    });
  });

  it("cannot fire the guardrail when the entry total is unknown (ongoing)", () => {
    expect(planCourWrite({ ...base, episode: 50, total: null })).toEqual({
      kind: "write",
      progress: 50,
      status: "CURRENT",
      completed: false,
    });
  });
});

describe("planCourWrite: rewatch", () => {
  const completed = entry({ status: "COMPLETED", progress: 12, repeat: 0 });

  it("never silently mutates a COMPLETED cour — asks to confirm first", () => {
    expect(planCourWrite({ ...base, episode: 3, entry: completed })).toEqual({
      kind: "needs_rewatch",
      episode: 3,
    });
    // even the final episode of a completed cour prompts, not writes
    expect(planCourWrite({ ...base, episode: 12, entry: completed })).toEqual({
      kind: "needs_rewatch",
      episode: 12,
    });
  });

  it("once confirmed, tracks the rewatch as REPEATING", () => {
    expect(
      planCourWrite({ ...base, episode: 3, entry: completed, rewatchConfirmed: true }),
    ).toEqual({ kind: "write", progress: 3, status: "REPEATING", completed: false });
  });

  it("re-completes and bumps the repeat count on the final rewatched episode", () => {
    expect(
      planCourWrite({
        ...base,
        episode: 12,
        entry: entry({ status: "COMPLETED", progress: 12, repeat: 1 }),
        rewatchConfirmed: true,
      }),
    ).toEqual({ kind: "write", progress: 12, status: "COMPLETED", repeat: 2, completed: true });
  });

  it("continues an in-progress REPEATING entry without a prompt", () => {
    expect(
      planCourWrite({ ...base, episode: 5, entry: entry({ status: "REPEATING", progress: 4 }) }),
    ).toEqual({ kind: "write", progress: 5, status: "REPEATING", completed: false });
    // final episode of the rewatch completes + increments repeat
    expect(
      planCourWrite({
        ...base,
        episode: 12,
        entry: entry({ status: "REPEATING", progress: 11, repeat: 0 }),
      }),
    ).toEqual({ kind: "write", progress: 12, status: "COMPLETED", repeat: 1, completed: true });
  });
});
