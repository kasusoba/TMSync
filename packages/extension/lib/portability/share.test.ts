import { type Recipe, parseLibrary } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { sourceFile } from "./share";

const recipe = {
  id: "x-movie",
  schemaVersion: 2,
  name: "X",
  match: { urlPattern: "/movie", hostnames: ["x.to"] },
  mediaType: "auto",
  tracker: "trakt",
  video: { selector: "video", frame: "auto" },
  extract: { title: { source: "title" } },
} as Recipe;

describe("sourceFile", () => {
  it("writes a file that reads back as a recipe source", () => {
    const json = sourceFile(
      [recipe],
      [
        { id: "x", name: "X", enabled: true, source: "user", host: "x.to", movie: "/m/{tmdb}" },
        { id: "y", name: "Y", enabled: true, source: "source", sourceId: "s", host: "y.to" },
      ],
      "My sites",
    );
    const lib = parseLibrary(JSON.parse(json));
    expect(lib.name).toBe("My sites");
    expect(lib.recipes).toEqual([recipe]);
    expect(lib.links).toEqual([
      { id: "x", name: "X", host: "x.to", movie: "/m/{tmdb}", tracker: "trakt" },
    ]);
  });
});
