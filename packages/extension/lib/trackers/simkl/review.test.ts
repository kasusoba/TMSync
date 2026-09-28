import { describe, expect, it } from "vitest";
import { anyNotFound } from "./review";

describe("anyNotFound", () => {
  it("flags an item Simkl ignored despite the 201", () => {
    expect(
      anyNotFound({ added: { movies: 0 }, not_found: { movies: [{ ids: {} }], shows: [] } }),
    ).toBe(true);
    expect(anyNotFound({ added: { shows: 1 }, not_found: { movies: [], shows: [] } })).toBe(false);
    expect(anyNotFound(undefined)).toBe(false);
  });
});
