import { describe, expect, it } from "vitest";
import { findHostAdoption, matchRecipe, matchesUrl, selectRecipe } from "./match";
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

  it("keeps a host-free pattern inside the recipe's host scope", () => {
    const r = recipe({ match: { urlPattern: "/watch", hostnames: ["stream.tld"] } });
    expect(matchRecipe(r, { document: doc, url: "https://stream.tld/watch/1" })).toBe(true);
    expect(matchRecipe(r, { document: doc, url: "https://other.tld/watch/1" })).toBe(false);
  });

  it("treats a www host as the same site", () => {
    const r = recipe({ match: { urlPattern: "/watch", hostnames: ["stream.tld"] } });
    expect(matchRecipe(r, { document: doc, url: "https://www.stream.tld/watch/1" })).toBe(true);
  });

  it("matches every host when the recipe lists none", () => {
    const r = recipe({ match: { urlPattern: "/watch", domFingerprint: "#player" } });
    expect(matchRecipe(r, { document: doc, url: "https://any.tld/watch/1" })).toBe(true);
  });
});

describe("matchesUrl", () => {
  it("applies the host scope without a document", () => {
    const r = recipe({ match: { urlPattern: "/watch", hostnames: ["stream.tld"] } });
    expect(matchesUrl(r, "https://stream.tld/watch/1")).toBe(true);
    expect(matchesUrl(r, "https://other.tld/watch/1")).toBe(false);
  });
});

describe("findHostAdoption", () => {
  const doc = parse('<html><body><div id="player"></div></body></html>');
  const moved = { document: doc, url: "https://stream.app/watch/1" };

  it("offers a recipe whose only mismatch is the host", () => {
    const r = recipe({
      match: { urlPattern: "/watch", domFingerprint: "#player", hostnames: ["stream.tld"] },
    });
    expect(findHostAdoption([r], moved)?.id).toBe("test");
  });

  it("offers an older recipe that anchors the host in its pattern", () => {
    const r = recipe({
      match: { urlPattern: "stream\\.tld/watch", domFingerprint: "#player" },
    });
    expect(findHostAdoption([r], moved)?.id).toBe("test");
  });

  it("skips a recipe with no fingerprint (too weak to offer)", () => {
    const r = recipe({ match: { urlPattern: "/watch", hostnames: ["stream.tld"] } });
    expect(findHostAdoption([r], moved)).toBeNull();
  });

  it("skips a recipe whose fingerprint is absent from the page", () => {
    const r = recipe({
      match: { urlPattern: "/watch", domFingerprint: "#nope", hostnames: ["stream.tld"] },
    });
    expect(findHostAdoption([r], moved)).toBeNull();
  });

  it("skips a recipe whose path does not fit", () => {
    const r = recipe({
      match: { urlPattern: "/series", domFingerprint: "#player", hostnames: ["stream.tld"] },
    });
    expect(findHostAdoption([r], moved)).toBeNull();
  });

  it("skips a recipe that already covers this host", () => {
    const r = recipe({
      match: { urlPattern: "/watch", domFingerprint: "#player", hostnames: ["stream.app"] },
    });
    expect(findHostAdoption([r], moved)).toBeNull();
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
