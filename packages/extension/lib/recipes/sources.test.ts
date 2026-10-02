import type { LibraryLink, Recipe } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import type { RecipeSource, SourceCache } from "../storage";
import {
  mergeRecipes,
  recipeHash,
  resolveSourceLinks,
  resolveSources,
  sourceLabel,
  staleForks,
} from "./sources";

const recipe = (id: string, hostnames: string[], urlPattern = "/movie/"): Recipe =>
  ({
    id,
    schemaVersion: 1,
    name: id,
    match: { urlPattern, hostnames },
    extract: { title: { source: "title" } },
  }) as unknown as Recipe;

const src = (id: string, enabled = true): RecipeSource => ({
  id,
  url: `https://raw.githubusercontent.com/u/${id}/main/sites.json`,
  enabled,
});
const cache = (recipes: Recipe[], links: LibraryLink[] = []): SourceCache => ({
  recipes,
  links,
  fetchedAt: 1,
});
const ids = (list: { recipe: Recipe; sourceId?: string }[]) =>
  list.map((r) => `${r.sourceId ?? "custom"}:${r.recipe.id}`);

describe("resolveSources", () => {
  it("takes a whole site from the highest source, never a mix", () => {
    const caches = {
      a: cache([recipe("x-movie", ["x.to"])]),
      b: cache([recipe("x-movie", ["x.to"]), recipe("x-tv", ["x.to"], "/tv/")]),
    };
    const out = resolveSources([src("a"), src("b")], caches, {});
    expect(ids(out.recipes)).toEqual(["a:x-movie"]);
    expect(out.choices).toEqual([{ hosts: ["x.to"], sourceId: "a", others: ["b"], pinned: false }]);
  });

  it("uses the pinned source for a site", () => {
    const caches = {
      a: cache([recipe("x-movie", ["x.to"])]),
      b: cache([recipe("x-movie", ["x.to"]), recipe("x-tv", ["www.x.to"], "/tv/")]),
    };
    const out = resolveSources([src("a"), src("b")], caches, { "x.to": "b" });
    expect(ids(out.recipes)).toEqual(["b:x-movie", "b:x-tv"]);
    expect(out.choices[0]).toMatchObject({ sourceId: "b", others: ["a"], pinned: true });
  });

  it("ignores a pin to a source that does not cover the site", () => {
    const caches = { a: cache([recipe("x", ["x.to"])]), b: cache([recipe("x", ["x.to"])]) };
    const out = resolveSources([src("a"), src("b")], caches, { "x.to": "gone" });
    expect(ids(out.recipes)).toEqual(["a:x"]);
  });

  it("joins a site across sources by any shared host (a domain move)", () => {
    const caches = {
      a: cache([recipe("old", ["x.to"])]),
      b: cache([recipe("new", ["x.to", "x.pk"])]),
    };
    const out = resolveSources([src("b"), src("a")], caches, {});
    expect(ids(out.recipes)).toEqual(["b:new"]);
  });

  it("keeps sites that only one source covers, in priority order", () => {
    const caches = { a: cache([recipe("y", ["y.to"])]), b: cache([recipe("x", ["x.to"])]) };
    const out = resolveSources([src("b"), src("a")], caches, {});
    expect(ids(out.recipes)).toEqual(["b:x", "a:y"]);
    expect(out.choices).toEqual([]);
  });

  it("skips disabled sources and sources with no copy yet", () => {
    const caches = { a: cache([recipe("x", ["x.to"])]), b: cache([recipe("x", ["x.to"])]) };
    const out = resolveSources([src("a", false), src("b"), src("c")], caches, {});
    expect(ids(out.recipes)).toEqual(["b:x"]);
  });

  it("orders host-free recipes by source priority", () => {
    const caches = {
      a: cache([recipe("any-a", [], "/watch/")]),
      b: cache([recipe("any-b", [], "/watch/"), recipe("x", ["x.to"])]),
    };
    const out = resolveSources([src("b"), src("a")], caches, {});
    expect(ids(out.recipes)).toEqual(["b:any-b", "b:x", "a:any-a"]);
  });
});

describe("mergeRecipes", () => {
  it("puts custom recipes first and shadows a source recipe with the same target", () => {
    const mine = recipe("mine", ["x.to"]);
    const out = mergeRecipes([mine], [{ recipe: recipe("theirs", ["x.to"]), sourceId: "a" }], {});
    expect(ids(out)).toEqual(["custom:mine"]);
  });

  it("shadows a forked recipe only in the source it was forked from", () => {
    const fork = recipe("x", ["x.to"], "/film/");
    const sourced = [
      { recipe: recipe("x", ["x.to"]), sourceId: "a" },
      { recipe: recipe("x", ["y.to"]), sourceId: "b" },
    ];
    const out = mergeRecipes([fork], sourced, { x: { sourceId: "a", hash: "0" } });
    expect(ids(out)).toEqual(["custom:x", "b:x"]);
  });

  it("never hides a source recipe that merely shares an id with one of the user's", () => {
    const sourced = [
      { recipe: recipe("x", ["x.to"]), sourceId: "a" },
      { recipe: recipe("x", ["y.to"]), sourceId: "b" },
    ];
    expect(ids(mergeRecipes([recipe("x", ["z.to"])], sourced, {}))).toEqual([
      "custom:x",
      "a:x",
      "b:x",
    ]);
  });
});

describe("staleForks", () => {
  it("reports a fork whose source version changed", () => {
    const original = recipe("x", ["x.to"]);
    const changed = recipe("x", ["x.to"], "/films/");
    const base = { x: { sourceId: "a", hash: recipeHash(original) } };
    const fork = recipe("x", ["x.to"], "/mine/");
    expect(staleForks([fork], [{ recipe: original, sourceId: "a" }], base)).toEqual([]);
    expect(staleForks([fork], [{ recipe: changed, sourceId: "a" }], base)).toEqual(["x"]);
    expect(staleForks([fork], [], base)).toEqual([]);
  });
});

describe("resolveSourceLinks", () => {
  const link = (id: string, host: string): LibraryLink => ({
    id,
    name: id,
    host,
    movie: "/m/{tmdb}",
    tracker: "trakt",
  });

  it("offers one link per host, from the pinned or highest source", () => {
    const caches = {
      a: cache([], [link("x-a", "x.to")]),
      b: cache([], [link("x-b", "www.x.to"), link("y", "y.to")]),
    };
    const byOrder = resolveSourceLinks([src("a"), src("b")], caches, {});
    expect(byOrder.map((l) => `${l.sourceId}:${l.id}`)).toEqual(["a:x-a", "b:y"]);
    const pinned = resolveSourceLinks([src("a"), src("b")], caches, { "x.to": "b" });
    expect(pinned.map((l) => `${l.sourceId}:${l.id}`)).toEqual(["b:x-b", "b:y"]);
  });

  it("keeps one link per id", () => {
    const caches = { a: cache([], [link("s", "x.to")]), b: cache([], [link("s", "y.to")]) };
    expect(resolveSourceLinks([src("a"), src("b")], caches, {}).map((l) => l.sourceId)).toEqual([
      "a",
    ]);
  });
});

describe("sourceLabel", () => {
  it("uses the file name, else the URL host", () => {
    expect(sourceLabel(src("a"), { ...cache([]), name: "Mine" })).toBe("Mine");
    expect(sourceLabel(src("a"))).toBe("raw.githubusercontent.com");
  });
});
