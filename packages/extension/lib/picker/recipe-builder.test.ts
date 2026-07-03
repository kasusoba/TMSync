import { type Recipe, extract } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
// Reuse the recipe-snapshot fixtures.
import episodeHtml from "../../test/fixtures/sample-episode.html?raw";
import movieHtml from "../../test/fixtures/sample-movie.html?raw";
import {
  type RecipeDraft,
  autoDetectFields,
  buildRecipe,
  countNumbers,
  defaultRecipeName,
  deriveQuickLink,
  detectTmdbIdField,
  emptyDraft,
  escapeRegex,
  previewDraft,
  queryParamRegex,
  recipeToDraft,
  splitNumbers,
  splitTitle,
  suggestUrlPattern,
  titleSegmentRegex,
  urlTokenRegex,
} from "./recipe-builder";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("defaultRecipeName", () => {
  it("capitalizes the domain for bare/www hosts", () => {
    expect(defaultRecipeName("www.miruro.to")).toBe("Miruro");
    expect(defaultRecipeName("cineby.at")).toBe("Cineby");
    expect(defaultRecipeName("popcornmovies.org")).toBe("Popcornmovies");
  });
  it("keeps the full host when a real subdomain is present", () => {
    expect(defaultRecipeName("watch.example.com")).toBe("watch.example.com");
  });
});

describe("deriveQuickLink", () => {
  it("derives a movie template from a numeric id", () => {
    expect(deriveQuickLink("https://cineby.at/movie/693134", "trakt")).toEqual({
      movie: "https://cineby.at/movie/{tmdb}",
    });
  });

  it("derives a tv template from a /{id}/{season}/{episode} path", () => {
    expect(deriveQuickLink("https://cineby.at/tv/273240/1/2", "trakt", true)).toEqual({
      tv: "https://cineby.at/tv/{tmdb}/{season}/{episode}",
    });
  });

  it("derives a tv template from a /{slug}/{s}-{e} path", () => {
    expect(
      deriveQuickLink("https://popcornmovies.org/episode/the-rookie/2-4", "trakt", true),
    ).toEqual({ tv: "https://popcornmovies.org/episode/{slug}/{season}-{episode}" });
  });

  it("derives an anime template (slug) for AniList", () => {
    expect(deriveQuickLink("https://reanime.to/watch/frieren-eu9jz6", "anilist")).toEqual({
      anime: "https://reanime.to/watch/{slug}",
    });
  });
});

describe("page-title segments (SPA players, e.g. rivestream)", () => {
  it("splits a title by its delimiter into trimmed parts", () => {
    expect(splitTitle("Rive | Watch | The Super Mario Bros. Movie")).toEqual({
      separator: "|",
      parts: ["Rive", "Watch", "The Super Mario Bros. Movie"],
    });
    expect(splitTitle("Just A Title")).toEqual({ separator: "", parts: ["Just A Title"] });
  });

  it("titleSegmentRegex captures the Nth segment from the page title (via extract)", () => {
    const doc = new DOMParser().parseFromString(
      "<title>Rive | Watch | The Super Mario Bros. Movie</title>",
      "text/html",
    );
    const recipe: Recipe = {
      id: "r",
      schemaVersion: 2,
      name: "Rive",
      match: { urlPattern: ".*" },
      mediaType: "auto",
      tracker: "trakt",
      video: { selector: "video", frame: "iframe", watchedThreshold: 0.8 },
      extract: {
        title: {
          source: "title",
          regex: titleSegmentRegex("|", 2),
          group: 1,
          transforms: ["trim", "collapseSpaces"],
        },
      },
    };
    expect(extract(recipe, { document: doc, url: "https://rive/watch?type=movie&id=5" })).toEqual({
      ok: true,
      media: { mediaType: "movie", title: "The Super Mario Bros. Movie" },
    });
  });

  it("splits a tab title on the spaced hyphen ('Michael - bCine')", () => {
    expect(splitTitle("Michael - bCine")).toEqual({
      separator: " - ",
      parts: ["Michael", "bCine"],
    });
    // a hyphenated title must NOT be split by the bare hyphen
    expect(splitTitle("Spider-Man")).toEqual({ separator: "", parts: ["Spider-Man"] });
  });

  it("titleSegmentRegex picks the movie from a '<title> - <site>' tab title", () => {
    const doc = new DOMParser().parseFromString("<title>Michael - bCine</title>", "text/html");
    const recipe: Recipe = {
      id: "r",
      schemaVersion: 2,
      name: "bCine",
      match: { urlPattern: ".*" },
      mediaType: "movie",
      tracker: "trakt",
      video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
      extract: {
        title: {
          source: "title",
          regex: titleSegmentRegex(" - ", 0),
          group: 1,
          transforms: ["trim", "collapseSpaces"],
        },
      },
    };
    expect(extract(recipe, { document: doc, url: "https://bcine.ru/movie/936075" })).toEqual({
      ok: true,
      media: { mediaType: "movie", title: "Michael" },
    });
  });

  it("queryParamRegex extracts season/episode by name (mediaType auto → show)", () => {
    const doc = new DOMParser().parseFromString(
      "<title>Rive | Watch | Euphoria | S1-E1</title>",
      "text/html",
    );
    const recipe: Recipe = {
      id: "r",
      schemaVersion: 2,
      name: "Rive",
      match: { urlPattern: ".*" },
      mediaType: "auto",
      tracker: "trakt",
      video: { selector: "video", frame: "iframe", watchedThreshold: 0.8 },
      extract: {
        title: {
          source: "title",
          regex: titleSegmentRegex("|", 2),
          group: 1,
          transforms: ["trim"],
        },
        season: {
          source: "url",
          regex: queryParamRegex("season"),
          group: 1,
          transforms: ["toInt"],
        },
        episode: {
          source: "url",
          regex: queryParamRegex("episode"),
          group: 1,
          transforms: ["toInt"],
        },
      },
    };
    const url = "https://rive/watch?type=tv&id=85552&season=1&episode=1";
    expect(extract(recipe, { document: doc, url })).toEqual({
      ok: true,
      media: { mediaType: "show", title: "Euphoria", season: 1, episode: 1 },
    });
  });
});

describe("DOM number picking (one element packs several, e.g. '1x6 – Episode 6')", () => {
  const TITLE = "Teach You a Lesson: 1x6 – Episode 6";

  it("splitNumbers exposes each number with its positional ordinal", () => {
    expect(countNumbers(TITLE)).toBe(3);
    const nums = splitNumbers(TITLE).flatMap((p) => ("num" in p ? [p] : []));
    expect(nums.map((n) => n.num)).toEqual(["1", "6", "6"]);
    expect(nums.map((n) => n.ordinal)).toEqual([0, 1, 2]);
  });

  it("urlTokenRegex on a DOM field picks season=1 (ordinal 0) and episode=6 (ordinal 1)", () => {
    const doc = new DOMParser().parseFromString(
      `<div class="show">Teach You a Lesson</div><h1 class="ep">${TITLE}</h1>`,
      "text/html",
    );
    const recipe: Recipe = {
      id: "r",
      schemaVersion: 2,
      name: "Cinevibe",
      match: { urlPattern: ".*" },
      mediaType: "auto",
      tracker: "trakt",
      video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
      extract: {
        title: { source: "dom", selector: ".show", transforms: ["trim", "collapseSpaces"] },
        season: {
          source: "dom",
          selector: ".ep",
          regex: urlTokenRegex(0),
          group: 1,
          transforms: ["toInt"],
        },
        episode: {
          source: "dom",
          selector: ".ep",
          regex: urlTokenRegex(1),
          group: 1,
          transforms: ["toInt"],
        },
      },
    };
    expect(
      extract(recipe, { document: doc, url: "https://cinevibe.asia/watch/tv/276161" }),
    ).toEqual({
      ok: true,
      media: { mediaType: "show", title: "Teach You a Lesson", season: 1, episode: 6 },
    });
  });
});

describe("player-frame URL picking (S/E inside a cross-origin embed, e.g. 1embed.cc)", () => {
  it("reads season/episode from a player iframe's src attribute by ordinal", () => {
    // bcine.ru/tv/276161 hides S/E; the 1embed.cc iframe src carries it:
    // numbers are [1 (1embed), 276161, 1 (season), 6 (episode), 1 (auto_play)].
    // (readDom just does querySelector + getAttribute, so a non-<iframe> element
    // carrying the same `src` exercises the identical path — and avoids happy-dom
    // trying to network-fetch a real iframe during the test.)
    const doc = new DOMParser().parseFromString(
      `<title>Teach You a Lesson - bCine</title>
       <div class="player" src="https://1embed.cc/embed/tv/276161/1/6?color=ffffff&auto_play=1"></div>`,
      "text/html",
    );
    const recipe: Recipe = {
      id: "r",
      schemaVersion: 2,
      name: "bCine",
      match: { urlPattern: ".*" },
      mediaType: "auto",
      tracker: "trakt",
      video: { selector: "video", frame: "iframe", watchedThreshold: 0.8 },
      extract: {
        title: {
          source: "title",
          regex: titleSegmentRegex(" - ", 0),
          group: 1,
          transforms: ["trim", "collapseSpaces"],
        },
        season: {
          source: "dom",
          selector: ".player",
          attr: "src",
          regex: urlTokenRegex(2),
          group: 1,
          transforms: ["toInt"],
        },
        episode: {
          source: "dom",
          selector: ".player",
          attr: "src",
          regex: urlTokenRegex(3),
          group: 1,
          transforms: ["toInt"],
        },
      },
    };
    expect(extract(recipe, { document: doc, url: "https://bcine.ru/tv/276161" })).toEqual({
      ok: true,
      media: { mediaType: "show", title: "Teach You a Lesson", season: 1, episode: 6 },
    });
  });
});

describe("TMDB id (auto-detect + resolve-by-id)", () => {
  it("detects the id from a named query param", () => {
    expect(detectTmdbIdField("https://www.rivestream.app/watch?type=movie&id=502356")).toEqual({
      source: "url",
      regex: queryParamRegex("id"),
      group: 1,
      transforms: ["toInt"],
    });
  });

  it("detects the id from a /movie|/tv path segment (not the season/episode)", () => {
    const field = detectTmdbIdField("https://cineby.at/tv/273240/1/2");
    expect(field).toEqual({
      source: "url",
      regex: "/(?:movie|tv|watch|series|show)/(\\d+)",
      group: 1,
      transforms: ["toInt"],
    });
    // and it captures the id (273240), not the season/episode
    const doc = new DOMParser().parseFromString("<title>x</title>", "text/html");
    const recipe: Recipe = {
      id: "r",
      schemaVersion: 2,
      name: "Cineby",
      match: { urlPattern: ".*" },
      mediaType: "movie",
      tracker: "trakt",
      video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
      // biome-ignore lint/style/noNonNullAssertion: asserted defined just above
      extract: { title: { source: "title" }, tmdbId: field! },
    };
    expect(
      extract(recipe, { document: doc, url: "https://cineby.at/tv/273240/1/2" }),
    ).toMatchObject({ ok: true, media: { tmdbId: 273240 } });
  });

  it("returns undefined when there's no id in the URL", () => {
    expect(detectTmdbIdField("https://twoseven.xyz/room/abc")).toBeUndefined();
  });

  it("builds + extracts an id-ONLY recipe (no title needed)", () => {
    // The 1embed case: the in-frame title is junk, so the user drops it and relies
    // on the id. Title is optional once a tmdbId is present.
    const draft: RecipeDraft = {
      ...emptyDraft("https://bcine.ru/movie/936075"),
      fields: { tmdbId: detectTmdbIdField("https://bcine.ru/movie/936075") },
    };
    const built = buildRecipe(draft, { id: "m", name: "bCine" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.recipe.extract?.title).toBeUndefined();

    const doc = new DOMParser().parseFromString("<title>x</title>", "text/html");
    expect(extract(built.recipe, { document: doc, url: "https://bcine.ru/movie/936075" })).toEqual({
      ok: true,
      media: { mediaType: "movie", title: "", tmdbId: 936075 },
    });
  });

  it("multi-track: trackers[] is authoritative; native hint inferred from fields", () => {
    const title = { title: { source: "title" as const } };
    const season = { source: "url" as const };

    // General show, both trackers on → trackers[] persisted; native hint = trakt (season present).
    const both = buildRecipe(
      {
        ...emptyDraft("https://cineby.at/tv/1429/3/15"),
        trackers: ["trakt", "anilist"],
        fields: { ...title, season },
      },
      { id: "s", name: "Cineby" },
    );
    expect(both.ok).toBe(true);
    if (both.ok) {
      expect(both.recipe.trackers).toEqual(["trakt", "anilist"]);
      expect(both.recipe.tracker).toBe("trakt");
    }

    // Dedicated anime, AniList only → single-tracker: no trackers[], tracker = anilist.
    const anime = buildRecipe(
      { ...emptyDraft("https://reanime.to/watch/frieren/3"), trackers: ["anilist"], fields: title },
      { id: "a", name: "reanime" },
    );
    expect(anime.ok).toBe(true);
    if (anime.ok) {
      expect(anime.recipe.trackers).toBeUndefined();
      expect(anime.recipe.tracker).toBe("anilist");
    }

    // Anime site, also mirror to Trakt → trackers[] persisted; native hint = anilist.
    const mirror = buildRecipe(
      {
        ...emptyDraft("https://reanime.to/watch/frieren/3"),
        trackers: ["anilist", "trakt"],
        fields: title,
      },
      { id: "m", name: "reanime" },
    );
    expect(mirror.ok).toBe(true);
    if (mirror.ok) {
      expect(mirror.recipe.trackers).toEqual(["anilist", "trakt"]);
      expect(mirror.recipe.tracker).toBe("anilist");
    }
  });

  it("drops season/episode from a movie recipe (would resolve as a show otherwise)", () => {
    // Regression: a movie page (bcine /movie/4977 = the film Paprika) whose draft
    // picked up a stray season/episode would resolve tmdb id 4977 in the *tv*
    // namespace (a 1979 series). A movie must never carry season/episode.
    const draft: RecipeDraft = {
      ...emptyDraft("https://bcine.ru/movie/4977"),
      mediaType: "movie",
      fields: {
        tmdbId: detectTmdbIdField("https://bcine.ru/movie/4977"),
        season: { source: "url", regex: urlTokenRegex(0), group: 1, transforms: ["toInt"] },
        episode: { source: "url", regex: urlTokenRegex(0), group: 1, transforms: ["toInt"] },
      },
    };
    const built = buildRecipe(draft, { id: "m", name: "bCine" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.recipe.extract?.season).toBeUndefined();
    expect(built.recipe.extract?.episode).toBeUndefined();

    const doc = new DOMParser().parseFromString("<title>x</title>", "text/html");
    expect(extract(built.recipe, { document: doc, url: "https://bcine.ru/movie/4977" })).toEqual({
      ok: true,
      media: { mediaType: "movie", title: "", tmdbId: 4977 },
    });
  });

  it("rejects a recipe with neither a title nor an id", () => {
    const draft: RecipeDraft = { ...emptyDraft("https://x/watch"), fields: {} };
    expect(buildRecipe(draft, { id: "x", name: "X" })).toMatchObject({ ok: false });
  });

  it("auto-detect includes the tmdbId field from the page URL", () => {
    const ctx = { document: parse(movieHtml), url: "https://cineby.at/movie/693134" };
    expect(autoDetectFields(ctx).tmdbId).toEqual({
      source: "url",
      regex: "/(?:movie|tv|watch|series|show)/(\\d+)",
      group: 1,
      transforms: ["toInt"],
    });
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
      // tmdbId auto-detected from the "/watch/1" path segment.
      media: { mediaType: "show", title: "The Pixel Frontier", season: 2, episode: 4, tmdbId: 1 },
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
