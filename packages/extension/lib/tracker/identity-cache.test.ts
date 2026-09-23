import { describe, expect, it } from "vitest";
import { OPEN_TOTAL_TTL_MS, freshHit, stamp } from "./identity-cache";

describe("freshHit", () => {
  const known = { id: 1, title: "x", episodes: 12 };
  const open = { id: 2, title: "y", episodes: null };

  it("keeps an identity with a known total for good, and drops the stamp", () => {
    expect(freshHit(stamp(known, 0), 10 * OPEN_TOTAL_TTL_MS)).toEqual(known);
    expect(freshHit({ ...known }, Date.now())).toEqual(known);
  });

  it("drops an unknown total after a day, so the total is read again", () => {
    expect(freshHit(stamp(open, 0), OPEN_TOTAL_TTL_MS - 1)).toEqual(open);
    expect(freshHit(stamp(open, 0), OPEN_TOTAL_TTL_MS)).toBeUndefined();
  });

  it("refetches an unknown total stored before the stamp existed", () => {
    expect(freshHit({ ...open }, Date.now())).toBeUndefined();
    expect(freshHit(undefined)).toBeUndefined();
  });
});
