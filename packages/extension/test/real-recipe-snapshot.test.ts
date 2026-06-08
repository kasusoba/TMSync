import { type ParsedMedia, extract, parseLibrary, selectRecipe } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
// The SHIPPED recipe library — the same file the extension fetches/bundles.
import rawLibrary from "../../../recipes/index.json";
// Saved real-site HTML (see each fixture's header comment for provenance).
import popcornEpisodeHtml from "./fixtures/popcornmovies-episode.html?raw";
import popcornMovieHtml from "./fixtures/popcornmovies-movie.html?raw";

/**
 * Snapshot harness for the REAL shipped recipes against saved real-site HTML.
 * This is the guard for "recipe rot": when a site redesigns or we edit a recipe,
 * the assertion fails deterministically and the diff shows exactly which field
 * moved. It does NOT detect rot in the wild (only loading the live site does) —
 * it pins what each shipped recipe is supposed to produce and catches our own
 * regressions fast, with no browser.
 *
 * Note: only server-rendered sites can be fixtured from "View Source". Cineby is
 * a client-rendered Next.js SPA whose media only exists in the DOM after JS runs,
 * so it is intentionally absent here — a snapshot would need its rendered DOM.
 */
const { recipes } = parseLibrary(rawLibrary);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const cases: Array<{ name: string; html: string; url: string; expected: ParsedMedia }> = [
  {
    name: "popcornmovies-movie.html",
    html: popcornMovieHtml,
    url: "https://popcornmovies.org/movie/srimulat-hidup-memang-komedi",
    expected: { mediaType: "movie", title: "Srimulat: Hidup Memang Komedi", year: 2023 },
  },
  {
    name: "popcornmovies-episode.html",
    html: popcornEpisodeHtml,
    url: "https://popcornmovies.org/episode/spider-noir/1-1",
    expected: { mediaType: "show", title: "Spider-Noir", year: 2026, season: 1, episode: 1 },
  },
];

describe("real recipe snapshots", () => {
  for (const { name, html, url, expected } of cases) {
    it(`extracts ${expected.title} from ${name}`, () => {
      const ctx = { document: parse(html), url };
      const recipe = selectRecipe(recipes, ctx);
      if (!recipe) throw new Error(`no shipped recipe matched fixture ${name}`);

      const result = extract(recipe, ctx);
      expect(result).toEqual({ ok: true, media: expected });
    });
  }
});
