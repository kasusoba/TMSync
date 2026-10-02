import { describe, expect, it } from "vitest";
import { newRecipeId, slugifyHost, uniqueRecipeId } from "./id";

describe("slugifyHost", () => {
  it("strips www., lowercases, and hyphenates dots", () => {
    expect(slugifyHost("www.exampleanime.to")).toBe("exampleanime-to");
    expect(slugifyHost("Examplemovies.at")).toBe("examplemovies-at");
    expect(slugifyHost("watch.example.co.uk")).toBe("watch-example-co-uk");
  });
});

describe("uniqueRecipeId", () => {
  it("returns the base when free, else appends -2, -3…", () => {
    expect(uniqueRecipeId("exampleanime-to", new Set())).toBe("exampleanime-to");
    expect(uniqueRecipeId("exampleanime-to", new Set(["exampleanime-to"]))).toBe(
      "exampleanime-to-2",
    );
    expect(
      uniqueRecipeId("exampleanime-to", new Set(["exampleanime-to", "exampleanime-to-2"])),
    ).toBe("exampleanime-to-3");
  });
});

describe("newRecipeId", () => {
  it("derives a stable slug, disambiguating same-host recipes", () => {
    expect(newRecipeId("www.exampleanime.to", [])).toBe("exampleanime-to");
    expect(newRecipeId("www.exampleanime.to", ["exampleanime-to"])).toBe("exampleanime-to-2");
  });
});
