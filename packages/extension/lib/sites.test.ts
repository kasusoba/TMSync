import type { Recipe } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { groupSites, uniqueHosts, withSiteHosts, withSiteName } from "./sites";

function recipe(id: string, match: Recipe["match"], name = id): Recipe {
  return {
    id,
    schemaVersion: 2,
    name,
    match,
    mediaType: "auto",
    tracker: "trakt",
    video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
    extract: { title: { source: "title" } },
  };
}

describe("groupSites", () => {
  it("groups recipes that share a host into one site", () => {
    const movie = recipe("movie", { urlPattern: "/movie", hostnames: ["cineby.at"] }, "Cineby");
    const tv = recipe("tv", { urlPattern: "/tv", hostnames: ["www.cineby.at"] });
    const other = recipe("other", { urlPattern: "/watch", hostnames: ["other.tld"] }, "Other");
    const sites = groupSites([movie, tv, other], []);
    expect(sites.map((s) => s.name)).toEqual(["Cineby", "Other"]);
    expect(sites[0]?.hosts).toEqual(["cineby.at"]);
    expect(sites[0]?.recipes.map((r) => r.recipe.id)).toEqual(["movie", "tv"]);
  });

  it("joins two sites once a recipe spans both of their hosts", () => {
    const a = recipe("a", { urlPattern: "/movie", hostnames: ["old.tld"] });
    const b = recipe("b", { urlPattern: "/tv", hostnames: ["new.tld"] });
    const bridge = recipe("bridge", { urlPattern: "/x", hostnames: ["old.tld", "new.tld"] });
    const sites = groupSites([a, b, bridge], []);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.hosts).toEqual(["old.tld", "new.tld"]);
  });

  it("reads the host an older recipe anchors in its pattern", () => {
    const sites = groupSites([recipe("old", { urlPattern: "cineby\\.at/movie" })], []);
    expect(sites[0]?.hosts).toEqual(["cineby.at"]);
  });

  it("keeps a host-free recipe as a site of its own", () => {
    const sites = groupSites([recipe("any", { urlPattern: "/watch" })], []);
    expect(sites[0]?.key).toBe("any:any");
    expect(sites[0]?.hosts).toEqual([]);
  });

  it("marks library recipes and drops the ones a custom recipe shadows", () => {
    const mine = recipe("cineby", { urlPattern: "/movie", hostnames: ["cineby.at"] });
    const shadowed = recipe("cineby", { urlPattern: "/old", hostnames: ["cineby.at"] });
    const shared = recipe("cineby-tv", { urlPattern: "/tv", hostnames: ["cineby.at"] });
    const [site] = groupSites([mine], [shadowed, shared]);
    expect(site?.recipes.map((r) => [r.recipe.match.urlPattern, r.library])).toEqual([
      ["/movie", false],
      ["/tv", true],
    ]);
  });
});

describe("uniqueHosts", () => {
  it("dedupes by comparison form and keeps the first spelling", () => {
    expect(uniqueHosts(["www.a.tld", "a.tld", "b.tld", ""])).toEqual(["www.a.tld", "b.tld"]);
  });
});

describe("withSiteHosts", () => {
  it("rewrites custom recipes in place and forks library ones", () => {
    const mine = recipe("mine", { urlPattern: "/movie", hostnames: ["old.tld"] });
    const lib = recipe("lib", { urlPattern: "old\\.tld/tv" });
    const unrelated = recipe("x", { urlPattern: "/x", hostnames: ["x.tld"] });
    const [site] = groupSites([mine], [lib]);
    if (!site) throw new Error("no site");
    const next = withSiteHosts(site, ["new.tld"], [mine, unrelated]);
    expect(next.map((r) => [r.id, r.match.hostnames, r.match.urlPattern])).toEqual([
      ["mine", ["new.tld"], "/movie"],
      ["x", ["x.tld"], "/x"],
      ["lib", ["new.tld"], "/tv"],
    ]);
  });
});

describe("withSiteName", () => {
  it("renames the site's custom recipes and leaves library ones alone", () => {
    const mine = recipe("mine", { urlPattern: "/movie", hostnames: ["a.tld"] }, "watch.a.tld");
    const lib = recipe("lib", { urlPattern: "/tv", hostnames: ["a.tld"] }, "Library A");
    const other = recipe("x", { urlPattern: "/x", hostnames: ["x.tld"] }, "X");
    const [site] = groupSites([mine, other], [lib]).filter((s) => s.hosts.includes("a.tld"));
    if (!site) throw new Error("no site");
    const next = withSiteName(site, "A", [mine, other]);
    expect(next.map((r) => r.name)).toEqual(["A", "X"]);
  });
});
