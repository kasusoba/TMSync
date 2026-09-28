import { describe, expect, it } from "vitest";
import { clampProgress } from "./types";

describe("clampProgress", () => {
  it("clamps to 0..100 and coerces non-finite to 0", () => {
    expect(clampProgress(42.5)).toBe(42.5);
    expect(clampProgress(-5)).toBe(0);
    expect(clampProgress(150)).toBe(100);
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("rounds to 2 decimals (avoids high-precision 422s)", () => {
    expect(clampProgress(37.49987)).toBe(37.5);
    expect(clampProgress(42.555)).toBe(42.56);
  });
});
