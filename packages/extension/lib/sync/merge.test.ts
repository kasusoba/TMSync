import { describe, expect, it } from "vitest";
import { type FreshCour, mergeCour } from "./merge";
import type { SyncWrite } from "./types";

const target = { id: 30, ids: { anilist: 30 }, mediaType: "show" as const, anime: true };
const entry = (w: Partial<Extract<SyncWrite, { op: "entry" }>>): SyncWrite => ({
  tracker: "anilist",
  op: "entry",
  target,
  create: false,
  ...w,
});
const rating = (score: number, picked?: boolean): SyncWrite => ({
  tracker: "anilist",
  op: "rating",
  level: "entry",
  target,
  score,
  ...(picked ? { picked } : {}),
});
const fresh = (f: Partial<FreshCour> = {}): FreshCour => ({
  status: "CURRENT",
  progress: 3,
  repeat: 0,
  score: null,
  ...f,
});

describe("mergeCour", () => {
  it("sends the planned write when nothing changed", () => {
    const w = entry({ progress: { from: 3, to: 8 }, status: { from: "CURRENT", to: "CURRENT" } });
    expect(mergeCour([w], fresh())).toEqual({ kind: "save", progress: 8 });
  });

  it("never lowers progress a scrobble raised since the preview", () => {
    const w = entry({ progress: { from: 3, to: 8 } });
    expect(mergeCour([w], fresh({ progress: 10 }))).toEqual({ kind: "none" });
  });

  it("never moves an entry completed since the preview", () => {
    const w = entry({
      progress: { from: 3, to: 12 },
      status: { from: "CURRENT", to: "COMPLETED" },
    });
    expect(mergeCour([w], fresh({ status: "COMPLETED", progress: 12 }))).toEqual({ kind: "none" });
  });

  it("keeps a status the user changed since the preview", () => {
    const w = entry({ progress: { from: 3, to: 5 }, status: { from: "CURRENT", to: "PAUSED" } });
    expect(mergeCour([w], fresh({ status: "DROPPED" }))).toEqual({ kind: "save", progress: 5 });
  });

  it("creates an entry that is still missing", () => {
    const w = entry({
      create: true,
      progress: { from: 0, to: 4 },
      status: { from: null, to: "CURRENT" },
    });
    expect(mergeCour([w, rating(80)], null)).toEqual({
      kind: "save",
      progress: 4,
      status: "CURRENT",
      score: 80,
    });
  });

  it("fills an empty rating only, unless the user picked it", () => {
    expect(mergeCour([rating(80)], fresh({ score: 60 }))).toEqual({ kind: "none" });
    expect(mergeCour([rating(80)], fresh())).toEqual({ kind: "save", score: 80 });
    expect(mergeCour([rating(80, true)], fresh({ score: 60 }))).toEqual({
      kind: "save",
      score: 80,
    });
  });

  it("does not rate an entry that is not on the list", () => {
    expect(mergeCour([rating(80)], null)).toEqual({ kind: "none" });
  });

  it("still raises the rewatch count of a completed entry", () => {
    const w = entry({ repeat: { from: 0, to: 2 } });
    expect(mergeCour([w], fresh({ status: "COMPLETED", progress: 12 }))).toEqual({
      kind: "save",
      repeat: 2,
    });
  });

  it("removes an entry, and is done when it is already gone", () => {
    const rm: SyncWrite = { tracker: "anilist", op: "remove", target, was: {} };
    expect(mergeCour([rm], fresh())).toEqual({ kind: "delete" });
    expect(mergeCour([rm], null)).toEqual({ kind: "none" });
  });
});
