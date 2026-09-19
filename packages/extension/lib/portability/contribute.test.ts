import type { Recipe } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { contribute } from "./contribute";

function recipe(id: string): Recipe {
  return {
    id,
    schemaVersion: 2,
    name: `Site ${id}`,
    match: { urlPattern: "/watch/(\\d+)", hostnames: [`${id}.example`] },
    mediaType: "auto",
    tracker: "trakt",
    video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
    extract: { title: { source: "meta", selector: "og:title" } },
  };
}

const body = (url: string) => new URL(url).searchParams.get("body") ?? "";

describe("contribute", () => {
  it("prefills one recipe's JSON in the issue", () => {
    const c = contribute([recipe("one")], []);
    expect(c.paste).toBe(false);
    expect(body(c.url)).toContain('"id": "one"');
    expect(new URL(c.url).searchParams.get("labels")).toBe("contribution");
  });

  it("asks to paste a bundle too large to prefill, with the same title and label", () => {
    const c = contribute(
      Array.from({ length: 40 }, (_, i) => recipe(`site${i}`)),
      [],
    );
    expect(c.paste).toBe(true);
    expect(c.url.length).toBeLessThan(7000);
    expect(body(c.url)).toContain("Replace this line with the JSON");
    expect(body(c.url)).toContain("ONE list");
    expect(body(c.url)).toContain("- and 10 more");
    expect(new URL(c.url).searchParams.get("title")).toBe("Contribute 40 items from TMSync");
    expect(new URL(c.url).searchParams.get("labels")).toBe("contribution");
    expect(JSON.parse(c.json)).toHaveLength(40);
  });

  it("puts one site's recipes in one issue named after the site", () => {
    const c = contribute([recipe("movie"), recipe("tv")], [], "Cineby");
    expect(new URL(c.url).searchParams.get("title")).toBe("Add site: Cineby (2 items)");
    expect(body(c.url)).toContain("- Recipe: Site movie");
    expect(JSON.parse(c.json)).toHaveLength(2);
  });
});
