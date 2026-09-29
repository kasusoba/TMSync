import { describe, expect, it } from "vitest";
import { STALE_MS, jobAlive } from "./job";
import { SYNC_JOB_VERSION, type SyncJob, readJob } from "./preview";

const job = (state: SyncJob["state"], beatAt: number): SyncJob => ({
  v: SYNC_JOB_VERSION,
  state,
  startedAt: 0,
  beatAt,
  reads: [],
});

describe("jobAlive", () => {
  it("a running job with a recent beat is alive", () => {
    expect(jobAlive(job("running", 1000), 1000 + STALE_MS - 1)).toBe(true);
  });
  it("a running job with no beat for a while was stopped", () => {
    expect(jobAlive(job("running", 1000), 1000 + STALE_MS)).toBe(false);
  });
  it("a finished job is not running", () => {
    expect(jobAlive(job("done", 1000), 1000)).toBe(false);
    expect(jobAlive(null, 0)).toBe(false);
  });
});

describe("readJob", () => {
  it("drops a job saved by an older build", () => {
    expect(readJob({ state: "done", startedAt: 0, beatAt: 0, reads: [] })).toBeNull();
    expect(readJob(null)).toBeNull();
  });
  it("keeps a job of this build", () => {
    const j = job("done", 1);
    expect(readJob(j)).toBe(j);
  });
});
