import type { Recipe } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { contributeAll, contributeRecipe } from "./contribute";

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
    const c = contributeRecipe(recipe("one"));
    expect(c.paste).toBe(false);
    expect(body(c.url)).toContain('"id": "one"');
    expect(new URL(c.url).searchParams.get("labels")).toBe("contribution");
  });

  it("asks to paste a bundle too large to prefill, with the same title and label", () => {
    const c = contributeAll(
      Array.from({ length: 40 }, (_, i) => recipe(`site${i}`)),
      [],
    );
    expect(c.paste).toBe(true);
    expect(c.url.length).toBeLessThan(7000);
    expect(body(c.url)).toContain("Replace this line with the JSON");
    expect(new URL(c.url).searchParams.get("title")).toBe("Contribute 40 items from TMSync");
    expect(new URL(c.url).searchParams.get("labels")).toBe("contribution");
    expect(JSON.parse(c.json)).toHaveLength(40);
  });
});
