import type { Recipe } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import type { ForkBase } from "../storage";
import {
  addedHosts,
  findMovedSite,
  forkBasesOf,
  groupSites as groupEffective,
  uniqueHosts,
  withSiteHosts,
  withSiteName,
} from "./sites";
import { mergeRecipes, recipeHash } from "./sources";

/** Group custom recipes plus recipes from one source "s", as the UI does. */
const groupSites = (custom: Recipe[], sourced: Recipe[], bases: Record<string, ForkBase> = {}) =>
  groupEffective(
    mergeRecipes(
      custom,
      sourced.map((recipe) => ({ recipe, sourceId: "s" })),
      bases,
    ),
  );

function recipe(id: string, match: Recipe["match"], name = id): Recipe {
  return {
    id,
    schemaVersion: 2,
    name,
    match,
    mediaType: "auto",
    tracker: "trakt",
    video: { selector: "video", frame: "auto" },
    extract: { title: { source: "title" } },
  };
}

describe("groupSites", () => {
  it("groups recipes that share a host into one site", () => {
    const movie = recipe(
      "movie",
      { urlPattern: "/movie", hostnames: ["examplemovies.at"] },
      "Examplemovies",
    );
    const tv = recipe("tv", { urlPattern: "/tv", hostnames: ["www.examplemovies.at"] });
    const other = recipe("other", { urlPattern: "/watch", hostnames: ["other.tld"] }, "Other");
    const sites = groupSites([movie, tv, other], []);
    expect(sites.map((s) => s.name)).toEqual(["Examplemovies", "Other"]);
    expect(sites[0]?.hosts).toEqual(["examplemovies.at"]);
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
    const sites = groupSites([recipe("old", { urlPattern: "examplemovies\\.at/movie" })], []);
    expect(sites[0]?.hosts).toEqual(["examplemovies.at"]);
  });

  it("keeps a host-free recipe as a site of its own", () => {
    const sites = groupSites([recipe("any", { urlPattern: "/watch" })], []);
    expect(sites[0]?.key).toBe("any:any");
    expect(sites[0]?.hosts).toEqual([]);
  });

  it("marks source recipes and drops the ones a fork shadows", () => {
    const mine = recipe("examplemovies", { urlPattern: "/movie", hostnames: ["examplemovies.at"] });
    const shadowed = recipe("examplemovies", {
      urlPattern: "/old",
      hostnames: ["examplemovies.at"],
    });
    const shared = recipe("examplemovies-tv", {
      urlPattern: "/tv",
      hostnames: ["examplemovies.at"],
    });
    const [site] = groupSites([mine], [shadowed, shared], {
      examplemovies: { sourceId: "s", hash: "0" },
    });
    expect(site?.recipes.map((r) => [r.recipe.match.urlPattern, r.sourceId])).toEqual([
      ["/movie", undefined],
      ["/tv", "s"],
    ]);
  });
});

describe("uniqueHosts", () => {
  it("dedupes by comparison form and keeps the first spelling", () => {
    expect(uniqueHosts(["www.a.tld", "a.tld", "b.tld", ""])).toEqual(["www.a.tld", "b.tld"]);
  });
});

describe("withSiteHosts", () => {
  it("rewrites custom recipes in place and forks source ones", () => {
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
    expect(forkBasesOf(site, [mine, unrelated])).toEqual({
      lib: { sourceId: "s", hash: recipeHash(lib) },
    });
  });
});

describe("withSiteName", () => {
  it("renames the site's custom recipes and leaves source ones alone", () => {
    const mine = recipe("mine", { urlPattern: "/movie", hostnames: ["a.tld"] }, "watch.a.tld");
    const lib = recipe("lib", { urlPattern: "/tv", hostnames: ["a.tld"] }, "Library A");
    const other = recipe("x", { urlPattern: "/x", hostnames: ["x.tld"] }, "X");
    const [site] = groupSites([mine, other], [lib]).filter((s) => s.hosts.includes("a.tld"));
    if (!site) throw new Error("no site");
    const next = withSiteName(site, "A", [mine, other]);
    expect(next.map((r) => r.name)).toEqual(["A", "X"]);
  });
});

describe("findMovedSite", () => {
  const examplewatchMovie = recipe(
    "m",
    { urlPattern: "/watch/movie", hostnames: ["examplewatch.to"] },
    "Examplewatch",
  );
  const examplewatchTv = recipe(
    "t",
    { urlPattern: "/watch/tv", hostnames: ["examplewatch.to"] },
    "Examplewatch",
  );
  const other = recipe("o", { urlPattern: "/watch", hostnames: ["other.tld"] }, "Other");

  it("finds the site with the same name on another domain", () => {
    const sites = groupSites([examplewatchMovie, examplewatchTv, other], []);
    expect(findMovedSite(sites, "https://examplewatch.pk/watch/movie/1423191")?.name).toBe(
      "Examplewatch",
    );
  });

  it("finds it even when no recipe path fits this URL", () => {
    const sites = groupSites([examplewatchTv], []);
    expect(findMovedSite(sites, "https://examplewatch.pk/")?.name).toBe("Examplewatch");
  });

  it("prefers the site whose recipe path fits when two share the name", () => {
    const tv = recipe(
      "a",
      { urlPattern: "/tv", hostnames: ["examplewatch.net"] },
      "Examplewatch TV",
    );
    const movie = recipe(
      "b",
      { urlPattern: "/watch/movie", hostnames: ["examplewatch.to"] },
      "Examplewatch",
    );
    const sites = groupSites([tv, movie], []);
    expect(findMovedSite(sites, "https://examplewatch.pk/watch/movie/1")?.name).toBe(
      "Examplewatch",
    );
  });

  it("offers nothing when a site already lists this domain", () => {
    const both = recipe("b", {
      urlPattern: "/x",
      hostnames: ["examplewatch.to", "www.examplewatch.pk"],
    });
    expect(findMovedSite(groupSites([both], []), "https://examplewatch.pk/x")).toBeNull();
  });

  it("offers nothing when no site shares the name", () => {
    expect(findMovedSite(groupSites([other], []), "https://examplewatch.pk/watch")).toBeNull();
  });
});

describe("addedHosts", () => {
  const a = recipe("a", { urlPattern: "/movie", hostnames: ["a.tld"] });
  const b = recipe("b", { urlPattern: "/tv", hostnames: ["www.b.tld"] });
  const c = recipe("c", { urlPattern: "/watch", hostnames: ["c.tld"] });

  it("lists only the hosts the new list brings in", () => {
    expect(addedHosts([a], [a, b])).toEqual(["www.b.tld"]);
  });

  it("skips a host the other list already covers", () => {
    expect(addedHosts([a], [a, b, c], [c])).toEqual(["www.b.tld"]);
  });

  it("treats www and bare hosts as one", () => {
    const bare = recipe("bare", { urlPattern: "/tv", hostnames: ["b.tld"] });
    expect(addedHosts([b], [b, bare])).toEqual([]);
  });

  it("is empty when a recipe goes away", () => {
    expect(addedHosts([a, b], [a])).toEqual([]);
  });
});
