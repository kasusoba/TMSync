import { type ParsedMedia, extract, parseRecipes, selectRecipe } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
// Vite `?raw` inlines the saved HTML as a string (works in the WXT/Vitest env,
// where import.meta.url is rewritten and fs paths can't be relied on).
import episodeHtml from "./fixtures/sample-episode.html?raw";
import movieHtml from "./fixtures/sample-movie.html?raw";
// Synthetic recipes paired with the fixtures below. TMSync ships no site recipes,
// so these synthetic pages are what pin the engine's output.
import sampleRecipes from "./fixtures/sample-recipes.json";

/**
 * Recipe-snapshot harness: given saved page HTML + a recipe, assert the parsed
 * media. Most regressions are "recipe rot" — selectors that stop matching when a
 * site changes — and this is what catches them early.
 */
const recipes = parseRecipes(sampleRecipes);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const cases: Array<{ name: string; html: string; url: string; expected: ParsedMedia }> = [
  {
    name: "sample-episode.html",
    html: episodeHtml,
    url: "https://samplestreamer.example/watch/the-pixel-frontier-s2e4",
    expected: { mediaType: "show", title: "The Pixel Frontier", season: 2, episode: 4 },
  },
  {
    name: "sample-movie.html",
    html: movieHtml,
    url: "https://samplecinema.example/film/neon-tides",
    expected: { mediaType: "movie", title: "Neon Tides", year: 2021 },
  },
];

describe("recipe snapshots", () => {
  for (const { name, html, url, expected } of cases) {
    it(`extracts ${expected.title} from ${name}`, () => {
      const ctx = { document: parse(html), url };
      const recipe = selectRecipe(recipes, ctx);
      if (!recipe) throw new Error(`no recipe matched fixture ${name}`);

      const result = extract(recipe, ctx);
      expect(result).toEqual({ ok: true, media: expected });
    });
  }
});
