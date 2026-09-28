import { describe, expect, it } from "vitest";
import { STALE_MS, type SyncJob, jobAlive } from "./run";

const job = (state: SyncJob["state"], beatAt: number): SyncJob => ({
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
