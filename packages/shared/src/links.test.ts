import { describe, expect, it } from "vitest";
import {
  buildAniListSiteLinks,
  buildSiteLinks,
  fillTemplate,
  slugify,
  trackerItemUrl,
} from "./links";
import type { LinkTemplates } from "./schema";

describe("fillTemplate", () => {
  it("substitutes present placeholders", () => {
    expect(
      fillTemplate("https://s/tv/{tmdb}/{season}/{episode}", { tmdb: "42", season: 1, episode: 2 }),
    ).toBe("https://s/tv/42/1/2");
  });

  it("returns null when a referenced placeholder is missing", () => {
    expect(fillTemplate("https://s/movie/{tmdb}", { tmdb: undefined })).toBeNull();
    expect(fillTemplate("https://s/movie/{tmdb}", {})).toBeNull();
  });
});

describe("slugify", () => {
  it("lowercases and hyphen-joins, trimming stray separators", () => {
    expect(slugify("The Rookie")).toBe("the-rookie");
    expect(slugify("Spider-Man: No Way Home!")).toBe("spider-man-no-way-home");
  });
});

describe("buildSiteLinks", () => {
  const cineby: LinkTemplates = {
    movie: "https://cineby.app/movie/{tmdb}",
    tv: "https://cineby.app/tv/{tmdb}/{season}/{episode}",
    search: "https://cineby.app/search/{title}",
  };

  it("returns a direct movie link from tmdb plus a search fallback", () => {
    expect(
      buildSiteLinks(cineby, { type: "movie", tmdb: "1034541", title: "Terrifier 3" }),
    ).toEqual({
      direct: "https://cineby.app/movie/1034541",
      search: "https://cineby.app/search/Terrifier%203",
    });
  });

  it("builds a direct tv link with season/episode", () => {
    expect(
      buildSiteLinks(cineby, { type: "tv", tmdb: "273240", season: 1, episode: 2 }).direct,
    ).toBe("https://cineby.app/tv/273240/1/2");
  });

  it("omits direct when the id is missing, keeping search", () => {
    expect(buildSiteLinks(cineby, { type: "movie", title: "The Rookie" })).toEqual({
      search: "https://cineby.app/search/The%20Rookie",
    });
  });

  it("supports a {slug} search (hyphen-joined title)", () => {
    const slugSite: LinkTemplates = { search: "https://popcornmovies.org/search/{slug}" };
    expect(
      buildSiteLinks(slugSite, { type: "tv", season: 2, episode: 4, title: "The Rookie" }),
    ).toEqual({
      search: "https://popcornmovies.org/search/the-rookie",
    });
  });

  it("uses the show slug (not the episode title) and strips its year for tv {slug}", () => {
    const site: LinkTemplates = {
      tv: "https://popcornmovies.org/episode/{slug}/{season}-{episode}",
    };
    expect(
      buildSiteLinks(site, {
        type: "tv",
        slug: "invincible-2021", // Trakt show slug carries a disambiguation year
        title: "Invincible 4x04 Hurm", // episode title — must NOT drive the slug
        season: 4,
        episode: 4,
      }),
    ).toEqual({ direct: "https://popcornmovies.org/episode/invincible/4-4" });
  });

  it("does not strip a trailing number that isn't a -YYYY suffix (e.g. 1923)", () => {
    const site: LinkTemplates = { tv: "https://s/{slug}" };
    expect(buildSiteLinks(site, { type: "tv", slug: "1923", season: 1, episode: 1 }).direct).toBe(
      "https://s/1923",
    );
  });

  it("uses the clean title slug for movie {slug}, not Trakt's year-suffixed url slug", () => {
    const site: LinkTemplates = { movie: "https://popcornmovies.org/movie/{slug}" };
    expect(
      buildSiteLinks(site, { type: "movie", slug: "terrifier-3-2024", title: "Terrifier 3" }),
    ).toEqual({ direct: "https://popcornmovies.org/movie/terrifier-3" });
  });

  it("keeps a year that is part of the movie title (Blade Runner 2049)", () => {
    const site: LinkTemplates = { movie: "https://s/movie/{slug}" };
    expect(
      buildSiteLinks(site, { type: "movie", slug: "blade-runner-2049", title: "Blade Runner 2049" })
        .direct,
    ).toBe("https://s/movie/blade-runner-2049");
  });

  it("exposes Trakt's raw slug as {slugyear}", () => {
    const site: LinkTemplates = { movie: "https://s/m/{slugyear}" };
    expect(
      buildSiteLinks(site, { type: "movie", slug: "terrifier-3-2024", title: "Terrifier 3" })
        .direct,
    ).toBe("https://s/m/terrifier-3-2024");
  });

  it("returns nothing when no template can be filled", () => {
    const tmdbOnly: LinkTemplates = { movie: "https://s/movie/{tmdb}" };
    expect(buildSiteLinks(tmdbOnly, { type: "movie", title: "X" })).toEqual({});
  });
});

describe("buildAniListSiteLinks", () => {
  const media = {
    anilistId: 147105,
    title: "Witch Hat Atelier",
    romaji: "Tongari Boushi no Atelier",
  };

  it("fills the anime template with id / title / slug / romaji", () => {
    expect(buildAniListSiteLinks({ anime: "https://s/anime/{slug}" }, media).direct).toBe(
      "https://s/anime/witch-hat-atelier",
    );
    expect(buildAniListSiteLinks({ anime: "https://s/a/{anilist}" }, media).direct).toBe(
      "https://s/a/147105",
    );
  });

  it("still fills the legacy {anilistId} alias (back-compat)", () => {
    expect(buildAniListSiteLinks({ anime: "https://s/a/{anilistId}" }, media).direct).toBe(
      "https://s/a/147105",
    );
  });

  it("URL-encodes the title and romaji in search", () => {
    expect(buildAniListSiteLinks({ search: "https://s/?q={title}" }, media).search).toBe(
      "https://s/?q=Witch%20Hat%20Atelier",
    );
    expect(buildAniListSiteLinks({ anime: "https://s/{romaji}" }, media).direct).toBe(
      "https://s/Tongari%20Boushi%20no%20Atelier",
    );
  });

  it("skips a template whose placeholder is missing", () => {
    expect(buildAniListSiteLinks({ anime: "https://s/a/{anilist}" }, { title: "X" })).toEqual({});
  });
});

describe("trackerItemUrl", () => {
  it("links a Trakt episode with season + episode", () => {
    expect(trackerItemUrl("trakt", 1390, { mediaType: "show", season: 1, episode: 13 })).toBe(
      "https://trakt.tv/shows/1390/seasons/1/episodes/13",
    );
  });

  it("links a Trakt show (no episode) and a movie", () => {
    expect(trackerItemUrl("trakt", 1390, { mediaType: "show" })).toBe(
      "https://trakt.tv/shows/1390",
    );
    expect(trackerItemUrl("trakt", 42, { mediaType: "movie", season: 1, episode: 1 })).toBe(
      "https://trakt.tv/movies/42",
    );
  });

  it("links an AniList entry by id, ignoring season/episode", () => {
    expect(trackerItemUrl("anilist", 154587, { season: 1, episode: 5 })).toBe(
      "https://anilist.co/anime/154587",
    );
  });
});
