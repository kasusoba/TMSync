import { type Recipe, extract } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
// Reuse the recipe-snapshot fixtures.
import episodeHtml from "../../test/fixtures/sample-episode.html?raw";
import movieHtml from "../../test/fixtures/sample-movie.html?raw";
import {
  type RecipeDraft,
  autoDetectFields,
  buildRecipe,
  deriveQuickLink,
  emptyDraft,
  escapeRegex,
  previewDraft,
  recipeToDraft,
  suggestUrlPattern,
  urlTokenRegex,
} from "./recipe-builder";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("deriveQuickLink", () => {
  const draft = (over: Partial<RecipeDraft> = {}): RecipeDraft => ({
    ...emptyDraft("https://x/"),
    ...over,
  });

  it("derives a movie template from a numeric id", () => {
    expect(
      deriveQuickLink(draft({ mediaType: "movie" }), "https://cineby.at/movie/693134"),
    ).toEqual({ movie: "https://cineby.at/movie/{tmdb}" });
  });

  it("derives a tv template from a /{id}/{season}/{episode} path", () => {
    expect(
      deriveQuickLink(draft({ mediaType: "show" }), "https://cineby.at/tv/273240/1/2"),
    ).toEqual({ tv: "https://cineby.at/tv/{tmdb}/{season}/{episode}" });
  });

  it("derives a tv template from a /{slug}/{s}-{e} path", () => {
    expect(
      deriveQuickLink(
        draft({ mediaType: "show" }),
        "https://popcornmovies.org/episode/the-rookie/2-4",
      ),
    ).toEqual({ tv: "https://popcornmovies.org/episode/{slug}/{season}-{episode}" });
  });

  it("derives an anime template (slug) for an AniList recipe", () => {
    expect(
      deriveQuickLink(
        draft({ tracker: "anilist", mediaType: "show" }),
        "https://reanime.to/watch/frieren-eu9jz6",
      ),
    ).toEqual({ anime: "https://reanime.to/watch/{slug}" });
  });
});

describe("escapeRegex / suggestUrlPattern", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("a.b+c")).toBe("a\\.b\\+c");
  });
  it("suggests hostname + first path segment as the url pattern", () => {
    expect(suggestUrlPattern("https://watch.example.tv/movie/42?x=1")).toBe(
      "watch\\.example\\.tv/movie",
    );
    expect(suggestUrlPattern("https://watch.example.tv/")).toBe("watch\\.example\\.tv");
  });
});

describe("urlTokenRegex (season/episode from URL)", () => {
  // Build a show recipe whose season/episode come from the Nth URL number.
  function urlRecipe(seasonOrdinal: number, episodeOrdinal: number): Recipe {
    return {
      id: "u",
      schemaVersion: 1,
      name: "U",
      match: { urlPattern: ".*" },
      mediaType: "show",
      tracker: "trakt",
      video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
      extract: {
        title: { source: "title" },
        season: {
          source: "url",
          regex: urlTokenRegex(seasonOrdinal),
          group: 1,
          transforms: ["toInt"],
        },
        episode: {
          source: "url",
          regex: urlTokenRegex(episodeOrdinal),
          group: 1,
          transforms: ["toInt"],
        },
      },
    };
  }

  it("cineby /tv/273240/1/2 → S1E2 (skip the show id)", () => {
    const doc = new DOMParser().parseFromString("<title>x</title>", "text/html");
    const url = "https://www.cineby.at/tv/273240/1/2?play=true";
    const r = extract(urlRecipe(1, 2), { document: doc, url });
    expect(r).toMatchObject({ ok: true, media: { season: 1, episode: 2 } });
  });

  it("popcornmovies /episode/the-rookie/1-2 → S1E2", () => {
    const doc = new DOMParser().parseFromString("<title>x</title>", "text/html");
    const url = "https://popcornmovies.org/episode/the-rookie/1-2";
    const r = extract(urlRecipe(0, 1), { document: doc, url });
    expect(r).toMatchObject({ ok: true, media: { season: 1, episode: 2 } });
  });
});

describe("autoDetectFields", () => {
  it("detects title + season + episode for an episode page (meta + jsonld)", () => {
    const ctx = { document: parse(episodeHtml), url: "https://x/watch" };
    const fields = autoDetectFields(ctx);
    expect(fields.title?.source).toBe("meta");
    expect(fields.season?.source).toBe("jsonld");
    expect(fields.episode?.source).toBe("jsonld");
  });

  it("detects title + year for a movie page", () => {
    const ctx = { document: parse(movieHtml), url: "https://x/film" };
    const fields = autoDetectFields(ctx);
    expect(fields.title).toBeDefined();
    expect(fields.year?.source).toBe("jsonld");
    expect(fields.season).toBeUndefined();
    expect(fields.episode).toBeUndefined();
  });
});

describe("buildRecipe + previewDraft", () => {
  it("fails without a title", () => {
    const draft = emptyDraft("https://x/watch");
    expect(buildRecipe(draft, { id: "x", name: "X" })).toMatchObject({ ok: false });
  });

  it("builds a valid recipe and previews the parsed media end-to-end", () => {
    const ctx = { document: parse(episodeHtml), url: "https://samplestreamer.example/watch/1" };
    const draft: RecipeDraft = {
      ...emptyDraft(ctx.url),
      fields: autoDetectFields(ctx),
    };

    const built = buildRecipe(draft, { id: "custom-1", name: "My Site" });
    expect(built.ok).toBe(true);

    const preview = previewDraft(draft, ctx);
    expect(preview).toEqual({
      ok: true,
      media: { mediaType: "show", title: "The Pixel Frontier", season: 2, episode: 4 },
    });
  });
});

describe("manual recipes", () => {
  it("builds a manual recipe with no extract (title not required)", () => {
    const draft: RecipeDraft = { ...emptyDraft("https://twoseven.xyz/room/abc"), manual: true };
    const built = buildRecipe(draft, { id: "m", name: "TwoSeven" });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.recipe.extract).toBeUndefined();
      expect(built.recipe.schemaVersion).toBe(2);
    }
  });

  it("carries an optional manualKey through build + round-trips via recipeToDraft", () => {
    const draft: RecipeDraft = {
      ...emptyDraft("https://twoseven.xyz/room/abc"),
      manual: true,
      manualKey: { source: "dom", selector: ".media-title", transforms: ["trim"] },
    };
    const built = buildRecipe(draft, { id: "m", name: "TwoSeven" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.recipe.manualKey?.selector).toBe(".media-title");

    const back = recipeToDraft(built.recipe);
    expect(back.manual).toBe(true);
    expect(back.manualKey?.selector).toBe(".media-title");
    expect(back.fields.title).toBeUndefined();
  });
});
