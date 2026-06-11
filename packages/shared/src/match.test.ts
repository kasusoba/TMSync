import { describe, expect, it } from "vitest";
import { matchRecipe, selectRecipe } from "./match";
import type { Recipe } from "./schema";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function recipe(partial: Partial<Recipe> & Pick<Recipe, "match">): Recipe {
  return {
    id: "test",
    schemaVersion: 1,
    name: "Test",
    mediaType: "auto",
    tracker: "trakt",
    video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
    extract: { title: { source: "title" } },
    ...partial,
  };
}

describe("matchRecipe", () => {
  const doc = parse('<html><body><div id="player"></div></body></html>');

  it("matches on url pattern + present fingerprint", () => {
    const r = recipe({ match: { urlPattern: "stream\\.tld/watch", domFingerprint: "#player" } });
    expect(matchRecipe(r, { document: doc, url: "https://stream.tld/watch/123" })).toBe(true);
  });

  it("fails when the fingerprint is absent (clone-resilient key)", () => {
    const r = recipe({ match: { urlPattern: ".*", domFingerprint: "#nope" } });
    expect(matchRecipe(r, { document: doc, url: "https://stream.tld/watch" })).toBe(false);
  });

  it("matches on url alone when no fingerprint is declared", () => {
    const r = recipe({ match: { urlPattern: "stream\\.tld" } });
    expect(matchRecipe(r, { document: doc, url: "https://stream.tld/x" })).toBe(true);
  });

  it("fails on a non-matching url", () => {
    const r = recipe({ match: { urlPattern: "other\\.tld" } });
    expect(matchRecipe(r, { document: doc, url: "https://stream.tld" })).toBe(false);
  });
});

describe("selectRecipe", () => {
  const doc = parse('<html><body><div id="player"></div></body></html>');
  const ctx = { document: doc, url: "https://stream.tld/watch" };

  it("returns the first matching recipe", () => {
    const a = recipe({ id: "a", match: { urlPattern: "nope" } });
    const b = recipe({ id: "b", match: { urlPattern: "stream\\.tld" } });
    expect(selectRecipe([a, b], ctx)?.id).toBe("b");
  });

  it("skips recipes requiring a newer schema version", () => {
    const future = recipe({ id: "future", schemaVersion: 99, match: { urlPattern: ".*" } });
    expect(selectRecipe([future], ctx)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(selectRecipe([recipe({ match: { urlPattern: "zzz" } })], ctx)).toBeNull();
  });
});
