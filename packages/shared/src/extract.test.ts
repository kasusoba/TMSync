import { describe, expect, it } from "vitest";
import { extract, isManualRecipe } from "./extract";
import type { Recipe } from "./schema";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Build a recipe from a partial, filling required structural fields. */
function recipe(partial: Partial<Recipe> & Pick<Recipe, "extract">): Recipe {
  return {
    id: "test",
    schemaVersion: 1,
    name: "Test",
    match: { urlPattern: ".*" },
    mediaType: "auto",
    video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
    ...partial,
  };
}

describe("extract — sources", () => {
  it("reads from meta (og:title) and a jsonld dotted path", () => {
    const doc = parse(`
      <html><head>
        <meta property="og:title" content="  The Expanse  " />
        <script type="application/ld+json">
          ${JSON.stringify({
            "@type": "TVEpisode",
            partOfTVSeason: { seasonNumber: 3 },
            episodeNumber: 7,
          })}
        </script>
      </head><body></body></html>`);

    const r = recipe({
      extract: {
        title: { source: "meta", selector: "og:title", transforms: ["trim"] },
        season: { source: "jsonld", selector: "partOfTVSeason.seasonNumber" },
        episode: { source: "jsonld", selector: "episodeNumber" },
      },
    });

    const result = extract(r, { document: doc, url: "https://x/watch" });
    expect(result).toEqual({
      ok: true,
      media: { mediaType: "show", title: "The Expanse", season: 3, episode: 7 },
    });
  });

  it("reads from url via regex capture group", () => {
    const doc = parse("<html><body></body></html>");
    const r = recipe({
      mediaType: "show",
      extract: {
        title: { source: "dom", selector: "h1" },
        season: { source: "url", regex: "/s(\\d+)/e(\\d+)", group: 1 },
        episode: { source: "url", regex: "/s(\\d+)/e(\\d+)", group: 2 },
      },
    });
    // title from dom is missing -> but title is required, so add one
    doc.body.innerHTML = "<h1>Dark</h1>";
    const result = extract(r, { document: doc, url: "https://x/s02/e05" });
    expect(result).toEqual({
      ok: true,
      media: { mediaType: "show", title: "Dark", season: 2, episode: 5 },
    });
  });

  it("reads a dom attribute instead of textContent", () => {
    const doc = parse(`<html><body><div id="t" data-title="Blade Runner"></div></body></html>`);
    const r = recipe({
      mediaType: "movie",
      extract: { title: { source: "dom", selector: "#t", attr: "data-title" } },
    });
    const result = extract(r, { document: doc, url: "https://x" });
    expect(result).toEqual({ ok: true, media: { mediaType: "movie", title: "Blade Runner" } });
  });

  it("reads document.title", () => {
    const doc = parse("<html><head><title>Heat (1995)</title></head><body></body></html>");
    const r = recipe({
      extract: {
        title: { source: "title", regex: "^(.*?)\\s*\\(", group: 1, transforms: ["trim"] },
        year: { source: "title", regex: "\\((\\d{4})\\)" },
      },
    });
    const result = extract(r, { document: doc, url: "https://x" });
    expect(result).toEqual({ ok: true, media: { mediaType: "movie", title: "Heat", year: 1995 } });
  });
});

describe("extract — mediaType inference", () => {
  it("auto -> movie when no season/episode", () => {
    const doc = parse("<html><body><h1>Arrival</h1></body></html>");
    const r = recipe({ extract: { title: { source: "dom", selector: "h1" } } });
    expect(extract(r, { document: doc, url: "https://x" })).toMatchObject({
      ok: true,
      media: { mediaType: "movie" },
    });
  });

  it("auto -> show when an episode is present", () => {
    const doc = parse("<html><body><h1>Severance</h1></body></html>");
    const r = recipe({
      extract: {
        title: { source: "dom", selector: "h1" },
        episode: { source: "url", regex: "e(\\d+)" },
      },
    });
    expect(extract(r, { document: doc, url: "https://x/e9" })).toMatchObject({
      ok: true,
      media: { mediaType: "show", episode: 9 },
    });
  });
});

describe("extract — quiet failure", () => {
  it("returns ok:false when the title cannot be read", () => {
    const doc = parse("<html><body></body></html>");
    const r = recipe({ extract: { title: { source: "dom", selector: ".missing" } } });
    const result = extract(r, { document: doc, url: "https://x" });
    expect(result.ok).toBe(false);
  });

  it("omits optional fields that are unreadable rather than failing", () => {
    const doc = parse("<html><body><h1>Tenet</h1></body></html>");
    const r = recipe({
      mediaType: "movie",
      extract: {
        title: { source: "dom", selector: "h1" },
        year: { source: "dom", selector: ".year" }, // absent
      },
    });
    const result = extract(r, { document: doc, url: "https://x" });
    expect(result).toEqual({ ok: true, media: { mediaType: "movie", title: "Tenet" } });
  });

  it("does not throw on a malformed selector", () => {
    const doc = parse("<html><body><h1>X</h1></body></html>");
    const r = recipe({
      extract: {
        title: { source: "dom", selector: "h1" },
        year: { source: "dom", selector: ":::bad" },
      },
    });
    expect(() => extract(r, { document: doc, url: "https://x" })).not.toThrow();
  });
});

describe("isManualRecipe", () => {
  const base = {
    id: "t",
    schemaVersion: 2,
    name: "T",
    match: { urlPattern: ".*" },
    mediaType: "auto" as const,
    video: { selector: "video", frame: "auto" as const, watchedThreshold: 0.8 },
  };

  it("is true when a recipe has no extract", () => {
    const manual: Recipe = { ...base, manualKey: { source: "title" } };
    expect(isManualRecipe(manual)).toBe(true);
    // extract() is total: it degrades quietly instead of throwing.
    const doc = parse("<html><body></body></html>");
    expect(extract(manual, { document: doc, url: "https://x" }).ok).toBe(false);
  });

  it("is false for a scraped recipe", () => {
    const scraped: Recipe = { ...base, extract: { title: { source: "title" } } };
    expect(isManualRecipe(scraped)).toBe(false);
  });
});
