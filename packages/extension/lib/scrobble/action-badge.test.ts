import { describe, expect, it } from "vitest";
import { statusDotColor } from "./action-badge";

describe("statusDotColor", () => {
  it("maps playback states to a dot colour", () => {
    expect(statusDotColor({ state: "watching" })).toBe("#10b981");
    expect(statusDotColor({ state: "paused" })).toBe("#f59e0b");
    expect(statusDotColor({ state: "scrobbled" })).toBe("#0ea5e9");
    expect(statusDotColor({ state: "error" })).toBe("#f43f5e");
  });

  it("shows no dot when idle/stopped or absent", () => {
    expect(statusDotColor({ state: "idle" })).toBeNull();
    expect(statusDotColor({ state: "stopped" })).toBeNull();
    expect(statusDotColor(null)).toBeNull();
  });

  it("uses the attention colour when the user must act, regardless of state", () => {
    expect(statusDotColor({ state: "idle", needEpisode: true })).toBe("#f97316");
    expect(statusDotColor({ state: "idle", pick: true })).toBe("#f97316");
    expect(statusDotColor({ state: "scrobbled", rewatch: true })).toBe("#f97316");
  });
});
