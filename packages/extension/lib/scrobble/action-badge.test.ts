import { describe, expect, it } from "vitest";
import { actionBadgeFor } from "./action-badge";

describe("actionBadgeFor", () => {
  it("maps playback states to a glyph", () => {
    expect(actionBadgeFor({ state: "watching" }).text).toBe("▶");
    expect(actionBadgeFor({ state: "paused" }).text).toBe("II");
    expect(actionBadgeFor({ state: "scrobbled" }).text).toBe("✓");
    expect(actionBadgeFor({ state: "error" }).text).toBe("!");
  });

  it("shows no badge when idle/stopped or absent", () => {
    expect(actionBadgeFor({ state: "idle" }).text).toBe("");
    expect(actionBadgeFor({ state: "stopped" }).text).toBe("");
    expect(actionBadgeFor(null).text).toBe("");
  });

  it("overrides with a '?' when the user must act, regardless of state", () => {
    expect(actionBadgeFor({ state: "idle", needEpisode: true }).text).toBe("?");
    expect(actionBadgeFor({ state: "idle", pick: true }).text).toBe("?");
    expect(actionBadgeFor({ state: "scrobbled", rewatch: true }).text).toBe("?");
  });
});
