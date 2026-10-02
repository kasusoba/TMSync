import { extract, parseLibrary, selectRecipe } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import raw from "../../../docs/examples/recipe-source.json";

// The example in docs/RECIPES.md must stay a valid source file: every entry
// survives validation, so a schema change that breaks it fails here.
describe("docs/examples/recipe-source.json", () => {
  it("parses whole", () => {
    const lib = parseLibrary(raw);
    expect(lib.name).toBe(raw.name);
    expect(lib.recipes).toHaveLength(raw.recipes.length);
    expect(lib.links).toHaveLength(raw.links.length);
  });

  it("reads the film title from an Internet Archive page", () => {
    const { recipes } = parseLibrary(raw);
    const document = new DOMParser().parseFromString(
      `<html><head><meta property="og:title" content="Night of the Living Dead : George A. Romero : Free Download, Borrow, and Streaming : Internet Archive"></head><body><video></video></body></html>`,
      "text/html",
    );
    const ctx = { document, url: "https://archive.org/details/night_of_the_living_dead" };
    const recipe = selectRecipe(recipes, ctx);
    expect(recipe?.id).toBe("archive-org");
    expect(recipe && extract(recipe, ctx)).toMatchObject({
      ok: true,
      media: { mediaType: "movie", title: "Night of the Living Dead" },
    });
  });
});
