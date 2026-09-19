import { describe, expect, it } from "vitest";
import { actionError } from "./errors";

describe("actionError", () => {
  it("names a full sync storage in plain words", () => {
    expect(actionError(new Error("QUOTA_BYTES_PER_ITEM quota exceeded"))).toMatch(
      /sync storage is full/,
    );
  });

  it("passes other errors through", () => {
    expect(actionError(new Error("boom"))).toBe("That didn’t work: boom");
  });
});
