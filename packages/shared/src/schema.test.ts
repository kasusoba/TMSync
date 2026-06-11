import { describe, expect, it } from "vitest";
import { LibraryLink, RecipeSchema } from "./schema";

const validRecipe = {
  id: "example-show",
  schemaVersion: 1,
  name: "Example",
  match: { urlPattern: "example\\.com/watch", domFingerprint: "#player" },
  extract: {
    title: { source: "meta", selector: "og:title", transforms: ["trim"] },
  },
};

describe("RecipeSchema", () => {
  it("accepts a minimal valid recipe and applies defaults", () => {
    const parsed = RecipeSchema.parse(validRecipe);
    expect(parsed.mediaType).toBe("auto");
    expect(parsed.video.selector).toBe("video");
    expect(parsed.video.frame).toBe("auto");
    expect(parsed.video.watchedThreshold).toBe(0.8);
  });

  it("defaults tracker to trakt when omitted (v1 back-compat)", () => {
    // validRecipe is schemaVersion 1 with no `tracker` — the original shape.
    const parsed = RecipeSchema.parse(validRecipe);
    expect(parsed.tracker).toBe("trakt");
  });

  it("accepts an explicit anilist tracker", () => {
    const anime = { ...validRecipe, schemaVersion: 2, tracker: "anilist" };
    const parsed = RecipeSchema.parse(anime);
    expect(parsed.tracker).toBe("anilist");
  });

  it("rejects an unknown tracker value", () => {
    const bad = { ...validRecipe, tracker: "simkl" };
    expect(RecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("library links default tracker to trakt and accept an anime template", () => {
    const trakt = LibraryLink.parse({ id: "s", name: "S", movie: "https://s/m/{tmdb}" });
    expect(trakt.tracker).toBe("trakt");
    const anime = LibraryLink.parse({
      id: "a",
      name: "A",
      tracker: "anilist",
      anime: "https://a/anime/{slug}",
    });
    expect(anime.tracker).toBe("anilist");
    expect(anime.anime).toBe("https://a/anime/{slug}");
  });

  it("rejects an unknown transform enum value", () => {
    const bad = {
      ...validRecipe,
      extract: { title: { source: "dom", selector: "h1", transforms: ["explode"] } },
    };
    expect(RecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a bad source enum value", () => {
    const bad = {
      ...validRecipe,
      extract: { title: { source: "cookie" } },
    };
    expect(RecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("requires a title field in extract", () => {
    const bad = { ...validRecipe, extract: {} };
    expect(RecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("requires match.urlPattern", () => {
    const bad = { ...validRecipe, match: { domFingerprint: "#player" } };
    expect(RecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects watchedThreshold outside 0..1", () => {
    const bad = { ...validRecipe, video: { watchedThreshold: 1.5 } };
    expect(RecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a manual recipe with no extract (optional manualKey)", () => {
    const manual = {
      id: "asbplayer",
      schemaVersion: 2,
      name: "asbplayer",
      match: { urlPattern: "killergerbah\\.github\\.io/asbplayer" },
      manualKey: { source: "title", transforms: ["trim"] },
    };
    const parsed = RecipeSchema.safeParse(manual);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.extract).toBeUndefined();
  });
});
