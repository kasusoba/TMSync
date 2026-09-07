import { type EngineContext, type Field, readField } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { type DraftFieldKey, pickSeparator, splitNumbers, splitSegments } from "./recipe-builder";
import { type FieldShape, buildPalette, looksSlug, shapeOf, textTransforms } from "./sources";

const HEAD = `
  <title>Teach You a Lesson - bCine</title>
  <meta property="og:title" content="Teach You a Lesson" />
  <meta name="description" content="Season 1, Episode 6" />
  <script type="application/ld+json">
    {"@type":"TVEpisode","name":"Teach You a Lesson","episodeNumber":6,
     "partOfTVSeason":{"seasonNumber":1},"datePublished":"2024-03-12"}
  </script>`;

const BODY = `<iframe id="player" src="https://1embed.cc/embed/tv/276161/1/6?auto_play=1"></iframe>`;

const URL_ = "https://bcine.ru/tv/breaking-bad/276161?season=1&episode=6";

/**
 * Render a fixture page into the live test document. The picker reads the real
 * document (a detached DOMParser one can't host an <iframe>), so this mirrors how
 * the palette actually runs.
 */
function ctx(head = HEAD, body = BODY, url = URL_): EngineContext {
  document.head.innerHTML = head;
  document.body.innerHTML = body;
  return { document, url };
}

function palette(shape: FieldShape, c: EngineContext = ctx()) {
  return buildPalette(c, shape, { selectorFor: (el) => `#${el.id}` });
}

/** Find a chip by the text it shows, inside a named source. */
function chipId(
  p: ReturnType<typeof palette>,
  sourceId: string,
  text: string,
  key?: string,
): string {
  const source = p.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`no source ${sourceId} (have: ${p.sources.map((s) => s.id)})`);
  const entries = key ? source.entries.filter((e) => e.key === key) : source.entries;
  for (const entry of entries) {
    for (const chip of entry.chips) {
      if (chip.kind === "pick" && chip.text === text) return chip.id;
    }
  }
  throw new Error(`no chip "${text}" in ${sourceId}`);
}

/** What the Field a chip commits to actually reads back off the page. The only
 * proof that matters, since the engine is what runs it at scrobble time. */
function readChip(p: ReturnType<typeof palette>, id: string, c: EngineContext): string | null {
  const field = p.fields.get(id);
  expect(field, `no field registered for chip ${id}`).toBeDefined();
  return readField(field as Field, c);
}

describe("shapeOf", () => {
  it("treats the title and the manual key as text, every other field as a number", () => {
    expect(shapeOf("title")).toBe("text");
    expect(shapeOf("manualKey")).toBe("text");
    for (const key of ["year", "season", "episode", "tmdbId"] as DraftFieldKey[]) {
      expect(shapeOf(key)).toBe("number");
    }
  });
});

describe("buildPalette: every source is offered for every field", () => {
  it("offers URL, player frame, meta and JSON-LD for a NUMBER field", () => {
    // No "title": this fixture's tab title holds no digit, so it has no number to
    // offer. When it does, it is offered like any other source (see below).
    expect(palette("number").sources.map((s) => s.id)).toEqual(["url", "frame", "meta", "jsonld"]);
  });

  it("offers the same sources for a TEXT field", () => {
    expect(palette("text").sources.map((s) => s.id)).toEqual([
      "url",
      "title",
      "frame",
      "meta",
      "jsonld",
    ]);
  });

  it("drops a source with nothing pickable for the shape", () => {
    // No numbers anywhere → no number chips → no sources at all.
    const bare = ctx("<title>Dune</title>", "", "https://cineby.at/movie");
    expect(palette("number", bare).sources).toEqual([]);
    expect(palette("text", bare).sources.map((s) => s.id)).toEqual(["url", "title"]);
  });
});

describe("a NUMBER field can be filled from any source", () => {
  it("from the URL, anchored to the query-param NAME when there is one", () => {
    const c = ctx();
    const p = palette("number", c);
    expect(readChip(p, chipId(p, "url", "6"), c)).toBe("6");
    expect(p.fields.get(chipId(p, "url", "6"))?.regex).toBe("[?&]episode=(\\d+)");
  });

  it("from the page title (previously Title-only)", () => {
    const c = ctx("<title>Frieren - Episode 3</title>", "", "https://x.y/w");
    const p = palette("number", c);
    expect(readChip(p, chipId(p, "title", "3"), c)).toBe("3");
  });

  it("from a cross-origin player frame's src, read live via the src attribute", () => {
    const c = ctx();
    const p = palette("number", c);
    const id = chipId(p, "frame", "6");
    expect(readChip(p, id, c)).toBe("6");
    expect(p.fields.get(id)).toMatchObject({ source: "dom", selector: "#player", attr: "src" });
  });

  it("from a meta tag (previously auto-detect only)", () => {
    const c = ctx();
    const p = palette("number", c);
    const id = chipId(p, "meta", "6", "description");
    expect(readChip(p, id, c)).toBe("6");
    expect(p.fields.get(id)).toMatchObject({ source: "meta", selector: "description" });
  });

  it("from a JSON-LD path (previously auto-detect only)", () => {
    const c = ctx();
    const p = palette("number", c);
    const id = chipId(p, "jsonld", "1", "partOfTVSeason.seasonNumber");
    expect(readChip(p, id, c)).toBe("1");
    expect(p.fields.get(id)).toMatchObject({
      source: "jsonld",
      selector: "partOfTVSeason.seasonNumber",
    });
  });
});

describe("a TEXT field can be filled from any source", () => {
  it("from a URL path segment, de-slugged so it can resolve on a tracker", () => {
    const c = ctx();
    const p = palette("text", c);
    const id = chipId(p, "url", "breaking-bad");
    expect(p.fields.get(id)?.transforms).toContain("deslugify");
    expect(readChip(p, id, c)).toBe("breaking bad");
  });

  it("from a page-title segment", () => {
    const c = ctx();
    const p = palette("text", c);
    expect(readChip(p, chipId(p, "title", "Teach You a Lesson"), c)).toBe("Teach You a Lesson");
    expect(readChip(p, chipId(p, "title", "bCine"), c)).toBe("bCine");
  });

  it("from a meta tag, taken whole when it has no delimiter", () => {
    const c = ctx();
    const p = palette("text", c);
    const id = chipId(p, "meta", "Teach You a Lesson", "og:title");
    expect(p.fields.get(id)?.regex).toBeUndefined();
    expect(readChip(p, id, c)).toBe("Teach You a Lesson");
  });

  it("from a JSON-LD path", () => {
    const c = ctx();
    const p = palette("text", c);
    expect(readChip(p, chipId(p, "jsonld", "Teach You a Lesson", "name"), c)).toBe(
      "Teach You a Lesson",
    );
  });

  it("keeps a real hyphen intact (only slug-shaped values are de-slugged)", () => {
    const c = ctx("<title>Spider-Man</title>", "", "https://x.y/w");
    const p = palette("text", c);
    expect(readChip(p, chipId(p, "title", "Spider-Man"), c)).toBe("Spider-Man");
  });
});

describe("chip helpers", () => {
  it("looksSlug only matches lowercase hyphen/underscore joined words", () => {
    expect(looksSlug("breaking-bad")).toBe(true);
    expect(looksSlug("sousou_no_frieren")).toBe(true);
    expect(looksSlug("Spider-Man")).toBe(false);
    expect(looksSlug("breaking bad")).toBe(false);
    expect(looksSlug("frieren")).toBe(false);
  });

  it("textTransforms de-slugs only a slug", () => {
    expect(textTransforms("breaking-bad")).toEqual(["trim", "deslugify", "collapseSpaces"]);
    expect(textTransforms("Spider-Man")).toEqual(["trim", "collapseSpaces"]);
  });

  it("pickSeparator uses / for a URL and the title delimiter otherwise", () => {
    expect(pickSeparator("https://bcine.ru/tv/276161")).toBe("/");
    expect(pickSeparator("Rive | Watch | Dune")).toBe("|");
    expect(pickSeparator("Dune")).toBe("");
  });

  it("splitSegments carries the RAW split index, so the regex survives empties", () => {
    // "https://a.b/c" splits to ["https:", "", "a.b", "c"]. The display drops the
    // empty, but "c" must still be captured by index 3, not 2.
    expect(splitSegments("https://a.b/c", "/")).toEqual([
      { text: "https:", index: 0 },
      { text: "a.b", index: 2 },
      { text: "c", index: 3 },
    ]);
  });

  it("splitNumbers tags a query-param number with its key", () => {
    const parts = splitNumbers("?type=tv&id=85552&season=1").flatMap((x) =>
      "num" in x ? [x] : [],
    );
    expect(parts).toEqual([
      { num: "85552", ordinal: 0, paramKey: "id" },
      { num: "1", ordinal: 1, paramKey: "season" },
    ]);
  });
});
