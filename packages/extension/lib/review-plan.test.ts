import { describe, expect, it } from "vitest";
import {
  type LoadedReview,
  noteChanged,
  planReview,
  ratingChanged,
  sharedReview,
} from "./review-plan";

const rated = (rating: number | null, text?: string, spoiler = false): LoadedReview => ({
  rating,
  note: text === undefined ? null : { text, spoiler },
});

describe("sharedReview", () => {
  it("is the shared value when every tracker agrees", () => {
    const s = sharedReview([rated(8, "good"), rated(8, "good")]);
    expect(s.rating).toEqual({ kind: "same", value: 8 });
    expect(s.note).toEqual({ kind: "same", value: { text: "good", spoiler: false } });
  });

  it("is mixed when ratings or notes differ, or only one tracker has one", () => {
    const s = sharedReview([rated(8, "good"), rated(6)]);
    expect(s.rating).toEqual({ kind: "mixed" });
    expect(s.note).toEqual({ kind: "mixed" });
  });
});

describe("ratingChanged", () => {
  it("counts clearing a saved rating as a change", () => {
    expect(ratingChanged({ kind: "same", value: 8 }, null)).toBe(true);
    expect(ratingChanged({ kind: "same", value: 8 }, 8)).toBe(false);
  });

  it("from mixed, only picking a rating is a change", () => {
    expect(ratingChanged({ kind: "mixed" }, null)).toBe(false);
    expect(ratingChanged({ kind: "mixed" }, 7)).toBe(true);
  });
});

describe("noteChanged", () => {
  const staged = (note: string, spoiler = false) => ({ rating: null, note, spoiler });
  it("from mixed, only typing is a change", () => {
    expect(noteChanged({ kind: "mixed" }, staged(""), true)).toBe(false);
    expect(noteChanged({ kind: "mixed" }, staged("new"), true)).toBe(true);
  });

  it("counts a spoiler flip only where a spoiler flag exists", () => {
    const shown = { kind: "same" as const, value: { text: "a b c d e", spoiler: false } };
    expect(noteChanged(shown, staged("a b c d e", true), true)).toBe(true);
    expect(noteChanged(shown, staged("a b c d e", true), false)).toBe(false);
  });
});

describe("planReview", () => {
  const none = { rating: false, note: false };

  it("sends nothing for untouched fields, even when trackers differ", () => {
    expect(
      planReview(rated(6, "old"), { rating: 8, note: "x", spoiler: false }, none, false),
    ).toEqual({});
  });

  it("removes the rating when the user cleared it", () => {
    const ops = planReview(
      rated(8),
      { rating: null, note: "", spoiler: false },
      { rating: true, note: false },
      false,
    );
    expect(ops).toEqual({ unrate: true });
  });

  it("does not unrate a tracker that has no rating", () => {
    const ops = planReview(
      rated(null),
      { rating: null, note: "", spoiler: false },
      { rating: true, note: false },
      false,
    );
    expect(ops).toEqual({});
  });

  it("sets a new rating only where it differs", () => {
    const staged = { rating: 8, note: "", spoiler: false };
    const changed = { rating: true, note: false };
    expect(planReview(rated(6), staged, changed, false)).toEqual({ rate: 8 });
    expect(planReview(rated(8), staged, changed, false)).toEqual({});
  });

  it("saves or deletes the note, and drops the spoiler flag where it doesn't exist", () => {
    const changed = { rating: false, note: true };
    expect(
      planReview(rated(null, "old"), { rating: null, note: "new", spoiler: true }, changed, false),
    ).toEqual({ saveNote: { text: "new", spoiler: false } });
    expect(
      planReview(rated(null, "old"), { rating: null, note: "", spoiler: false }, changed, false),
    ).toEqual({ deleteNote: true });
  });
});
