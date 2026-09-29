import { describe, expect, it } from "vitest";
import { describeWrite } from "./describe";

describe("describeWrite", () => {
  it("says what the tracker had before", () => {
    const target = { ids: {}, mediaType: "show" as const };
    expect(
      describeWrite({
        tracker: "mal",
        op: "remove",
        target,
        was: { status: "PLANNING", progress: 0, total: 1, rating: 80 },
      }),
    ).toBe("remove · was Plan to watch · 0/1 eps · rated 8/10");
    expect(
      describeWrite({
        tracker: "trakt",
        op: "episodes",
        target,
        add: [{ number: 3 }],
        was: { episodes: 2 },
      }),
    ).toBe("+1 episode · had 2");
    expect(describeWrite({ tracker: "trakt", op: "episodes", target, add: [{ number: 1 }] })).toBe(
      "+1 episode · new",
    );
    expect(
      describeWrite({
        tracker: "mal",
        op: "entry",
        target,
        create: false,
        status: { from: "CURRENT", to: "DROPPED" },
      }),
    ).toBe("update · Watching → Dropped");
  });
});
