import { describe, expect, it } from "vitest";
import { allServices, getService } from "./service";
import { ALL_TRACKERS, isCourFix } from "./types";

describe("tracker services", () => {
  it("has one service per tracker", () => {
    for (const t of ALL_TRACKERS) expect(getService(t)).toBeDefined();
    expect(allServices()).toHaveLength(ALL_TRACKERS.length);
  });

  it("gives every cour tracker its fix-match pins", () => {
    for (const t of ALL_TRACKERS.filter(isCourFix)) {
      expect(typeof getService(t).pins.apply).toBe("function");
    }
  });

  it("claims each alarm name once", () => {
    const names = allServices().flatMap((s) => Object.keys(s.alarms ?? {}));
    expect(new Set(names).size).toBe(names.length);
  });
});
