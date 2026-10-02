import { describe, expect, it } from "vitest";
import {
  animeQuickLinks,
  buildAniListSiteLinks,
  buildSiteLinks,
  fillTemplate,
  linkHost,
  siteQuickLinks,
  slugify,
  trackerItemUrl,
  withLinkHost,
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
  const examplemovies: LinkTemplates = {
    movie: "https://examplemovies.app/movie/{tmdb}",
    tv: "https://examplemovies.app/tv/{tmdb}/{season}/{episode}",
    search: "https://examplemovies.app/search/{title}",
  };

  it("returns a direct movie link from tmdb plus a search fallback", () => {
    expect(
      buildSiteLinks(examplemovies, { type: "movie", tmdb: "1034541", title: "Terrifier 3" }),
    ).toEqual({
      direct: "https://examplemovies.app/movie/1034541",
      search: "https://examplemovies.app/search/Terrifier%203",
    });
  });

  it("builds a direct tv link with season/episode", () => {
    expect(
      buildSiteLinks(examplemovies, { type: "tv", tmdb: "273240", season: 1, episode: 2 }).direct,
    ).toBe("https://examplemovies.app/tv/273240/1/2");
  });

  it("omits direct when the id is missing, keeping search", () => {
    expect(buildSiteLinks(examplemovies, { type: "movie", title: "The Rookie" })).toEqual({
      search: "https://examplemovies.app/search/The%20Rookie",
    });
  });

  it("supports a {slug} search (hyphen-joined title)", () => {
    const slugSite: LinkTemplates = { search: "https://exampleshows.org/search/{slug}" };
    expect(
      buildSiteLinks(slugSite, { type: "tv", season: 2, episode: 4, title: "The Rookie" }),
    ).toEqual({
      search: "https://exampleshows.org/search/the-rookie",
    });
  });

  it("uses the show slug (not the episode title) and strips its year for tv {slug}", () => {
    const site: LinkTemplates = {
      tv: "https://exampleshows.org/episode/{slug}/{season}-{episode}",
    };
    expect(
      buildSiteLinks(site, {
        type: "tv",
        slug: "invincible-2021", // Trakt show slug carries a disambiguation year
        title: "Invincible 4x04 Hurm", // episode title — must NOT drive the slug
        season: 4,
        episode: 4,
      }),
    ).toEqual({ direct: "https://exampleshows.org/episode/invincible/4-4" });
  });

  it("does not strip a trailing number that isn't a -YYYY suffix (e.g. 1923)", () => {
    const site: LinkTemplates = { tv: "https://s/{slug}" };
    expect(buildSiteLinks(site, { type: "tv", slug: "1923", season: 1, episode: 1 }).direct).toBe(
      "https://s/1923",
    );
  });

  it("uses the clean title slug for movie {slug}, not Trakt's year-suffixed url slug", () => {
    const site: LinkTemplates = { movie: "https://exampleshows.org/movie/{slug}" };
    expect(
      buildSiteLinks(site, { type: "movie", slug: "terrifier-3-2024", title: "Terrifier 3" }),
    ).toEqual({ direct: "https://exampleshows.org/movie/terrifier-3" });
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

describe("host-based templates", () => {
  const site: LinkTemplates = {
    host: "examplemovies.at",
    movie: "/movie/{tmdb}",
    tv: "/tv/{tmdb}/{season}/{episode}",
    search: "/search/{title}",
  };

  it("joins a path template to the site host", () => {
    expect(buildSiteLinks(site, { type: "movie", tmdb: "603", title: "The Matrix" })).toEqual({
      direct: "https://examplemovies.at/movie/603",
      search: "https://examplemovies.at/search/The%20Matrix",
    });
  });

  it("joins an anime path template too", () => {
    expect(
      buildAniListSiteLinks(
        { host: "exampleanime.to", anime: "/watch/{anilist}" },
        { anilistId: 21 },
      ).direct,
    ).toBe("https://exampleanime.to/watch/21");
  });

  it("skips a path template when the site has no host", () => {
    expect(buildSiteLinks({ movie: "/movie/{tmdb}" }, { type: "movie", tmdb: "603" })).toEqual({});
  });

  it("keeps an absolute template as it is", () => {
    expect(
      buildSiteLinks(
        { host: "examplemovies.at", movie: "https://other.tld/movie/{tmdb}" },
        { type: "movie", tmdb: "603" },
      ).direct,
    ).toBe("https://other.tld/movie/603");
  });
});

describe("linkHost / withLinkHost", () => {
  it("reads the explicit host as stored", () => {
    expect(linkHost({ host: "WWW.Examplemovies.At", movie: "/m/{tmdb}" })).toBe(
      "www.examplemovies.at",
    );
  });

  it("falls back to the host of the first absolute template", () => {
    expect(linkHost({ movie: "https://examplemovies.at/movie/{tmdb}" })).toBe("examplemovies.at");
  });

  it("is empty when there is nothing to read", () => {
    expect(linkHost({})).toBe("");
  });

  it("moves the site to a new host and relativizes its own templates", () => {
    const moved = withLinkHost(
      {
        movie: "https://examplemovies.at/movie/{tmdb}",
        search: "https://examplemovies.at/search/{title}",
      },
      "examplemovies.app",
    );
    expect(moved).toEqual({
      host: "examplemovies.app",
      movie: "/movie/{tmdb}",
      tv: undefined,
      anime: undefined,
      search: "/search/{title}",
    });
  });

  it("relativizes a template that differs only by www", () => {
    const moved = withLinkHost(
      { movie: "https://www.examplemovies.at/movie/{tmdb}" },
      "examplemovies.app",
    );
    expect(moved.movie).toBe("/movie/{tmdb}");
  });

  it("leaves a template on another host alone", () => {
    const moved = withLinkHost(
      { host: "examplemovies.at", movie: "https://other.tld/movie/{tmdb}" },
      "examplemovies.app",
    );
    expect(moved.movie).toBe("https://other.tld/movie/{tmdb}");
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

describe("quick-link lists", () => {
  it("drops a site with no link for the media", () => {
    const sites = [
      { name: "A", movie: "https://a.example/movie/{tmdb}" },
      { name: "B", tv: "https://b.example/tv/{tmdb}" },
    ];
    expect(siteQuickLinks(sites, { type: "movie", tmdb: "603" })).toEqual([
      { name: "A", direct: "https://a.example/movie/603" },
    ]);
  });

  it("fills {slug} from the crosswalk under the site's host field", () => {
    const sites = [{ name: "S", host: "anime.example", anime: "/watch/{slug}" }];
    const media = { anilistId: 21, title: "One Piece" };
    expect(animeQuickLinks(sites, media, { "anime.example:21": "op-tv" })).toEqual([
      { name: "S", direct: "https://anime.example/watch/op-tv" },
    ]);
  });
});
