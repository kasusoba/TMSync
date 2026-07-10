import { describe, expect, it } from "vitest";
import { newRecipeId, slugifyHost, uniqueRecipeId } from "./recipe-id";

describe("slugifyHost", () => {
  it("strips www., lowercases, and hyphenates dots", () => {
    expect(slugifyHost("www.miruro.to")).toBe("miruro-to");
    expect(slugifyHost("Cineby.at")).toBe("cineby-at");
    expect(slugifyHost("watch.example.co.uk")).toBe("watch-example-co-uk");
  });
});

describe("uniqueRecipeId", () => {
  it("returns the base when free, else appends -2, -3…", () => {
    expect(uniqueRecipeId("miruro-to", new Set())).toBe("miruro-to");
    expect(uniqueRecipeId("miruro-to", new Set(["miruro-to"]))).toBe("miruro-to-2");
    expect(uniqueRecipeId("miruro-to", new Set(["miruro-to", "miruro-to-2"]))).toBe("miruro-to-3");
  });
});

describe("newRecipeId", () => {
  it("derives a stable slug, disambiguating same-host recipes", () => {
    expect(newRecipeId("www.miruro.to", [])).toBe("miruro-to");
    expect(newRecipeId("www.miruro.to", ["miruro-to"])).toBe("miruro-to-2");
  });
});
