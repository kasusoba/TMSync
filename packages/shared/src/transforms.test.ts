import { describe, expect, it } from "vitest";
import { applyTransforms } from "./transforms";

describe("applyTransforms", () => {
  it("returns the value unchanged when no transforms are given", () => {
    expect(applyTransforms("  Hello ", undefined)).toBe("  Hello ");
  });

  it("applies trim / lowercase / uppercase", () => {
    expect(applyTransforms("  Hi  ", ["trim"])).toBe("Hi");
    expect(applyTransforms("Hi", ["lowercase"])).toBe("hi");
    expect(applyTransforms("Hi", ["uppercase"])).toBe("HI");
  });

  it("collapseSpaces normalizes internal whitespace and trims", () => {
    expect(applyTransforms("  a \n\t b   c ", ["collapseSpaces"])).toBe("a b c");
  });

  it("toInt extracts the first integer (incl. negatives)", () => {
    expect(applyTransforms("Season 12", ["toInt"])).toBe("12");
    expect(applyTransforms("-3 below", ["toInt"])).toBe("-3");
  });

  it("toInt yields empty string when there are no digits", () => {
    expect(applyTransforms("none here", ["toInt"])).toBe("");
  });

  it("deslugify turns a URL slug into spaced words", () => {
    expect(applyTransforms("breaking-bad", ["deslugify"])).toBe("breaking bad");
    expect(applyTransforms("sousou_no_frieren", ["deslugify"])).toBe("sousou no frieren");
    expect(applyTransforms("spider--man", ["deslugify"])).toBe("spider man");
  });

  it("applies transforms left to right", () => {
    expect(applyTransforms("  S03  ", ["trim", "toInt"])).toBe("3");
    expect(applyTransforms(" the-matrix ", ["trim", "deslugify", "collapseSpaces"])).toBe(
      "the matrix",
    );
  });
});
