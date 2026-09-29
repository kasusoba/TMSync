import { describe, expect, it } from "vitest";
import { explainMatch, matchRecipe, matchesUrl, selectRecipe } from "./match";
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
    video: { selector: "video", frame: "auto" },
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

describe("explainMatch", () => {
  const doc = parse('<html><body><div id="player"></div></body></html>');
  const url = "https://cinejoy.pk/tv/123";

  it("reports each check for recipes scoped to the host", () => {
    const r = recipe({
      name: "Cinejoy",
      match: { hostnames: ["cinejoy.pk"], urlPattern: "/watch/", domFingerprint: "#player" },
    });
    const [c] = explainMatch([r], { document: doc, url });
    expect(c).toMatchObject({ url: false, marker: true });
  });

  it("skips recipes for other hosts, and host-free ones whose pattern does not fit", () => {
    const other = recipe({ match: { hostnames: ["other.tld"], urlPattern: ".*" } });
    const loose = recipe({ match: { urlPattern: "nothere" } });
    expect(explainMatch([other, loose], { document: doc, url })).toEqual([]);
  });

  it("marks a missing page marker, and null when there is none", () => {
    const a = recipe({
      match: { hostnames: ["cinejoy.pk"], urlPattern: "/tv/", domFingerprint: "#x" },
    });
    const b = recipe({ match: { hostnames: ["cinejoy.pk"], urlPattern: "/tv/" } });
    const out = explainMatch([a, b], { document: doc, url });
    expect(out.map((c) => c.marker)).toEqual([false, null]);
  });
});
