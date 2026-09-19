import type { Recipe } from "@tmsync/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing";
import { customRecipes } from "./recipe-store";

const recipe = (id: string, pad = ""): Recipe => ({
  id,
  schemaVersion: 3,
  name: `Site ${id}${pad}`,
  match: { urlPattern: `/${id}/`, hostnames: [`${id}.example`] },
  mediaType: "movie",
  tracker: "trakt",
  video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
  extract: { title: { source: "meta", selector: "og:title" } },
});

describe("customRecipes", () => {
  beforeEach(() => fakeBrowser.reset());

  it("stores one sync key per recipe and keeps the list order", async () => {
    await customRecipes.setValue([recipe("b"), recipe("a")]);
    const area = await browser.storage.sync.get(null);
    expect(Object.keys(area).sort()).toEqual(["recipe:a", "recipe:b"]);
    expect((await customRecipes.getValue()).map((r) => r.id)).toEqual(["b", "a"]);
  });

  // The old single key held every recipe and hit the 8 KB per-key limit.
  it("holds more than 8 KB of recipes in total", async () => {
    const many = Array.from({ length: 30 }, (_, i) => recipe(`s${i}`, "x".repeat(200)));
    expect(JSON.stringify(many).length).toBeGreaterThan(8192);
    await customRecipes.setValue(many);
    expect(await customRecipes.getValue()).toHaveLength(30);
  });

  it("keeps a recipe's place when it is edited, and removes deleted ones", async () => {
    await customRecipes.setValue([recipe("a"), recipe("b"), recipe("c")]);
    await customRecipes.setValue([recipe("a"), recipe("c"), { ...recipe("b"), name: "B2" }]);
    expect((await customRecipes.getValue()).map((r) => r.name)).toEqual(["Site a", "B2", "Site c"]);
    await customRecipes.setValue([recipe("c")]);
    expect(Object.keys(await browser.storage.sync.get(null))).toEqual(["recipe:c"]);
  });

  it("skips a stored recipe that fails the schema", async () => {
    await browser.storage.sync.set({
      "recipe:bad": { at: 1, recipe: { id: "bad" } },
      "recipe:ok": { at: 2, recipe: recipe("ok") },
    });
    expect((await customRecipes.getValue()).map((r) => r.id)).toEqual(["ok"]);
  });

  it("reads the old single-key list and moves it on migrate", async () => {
    await browser.storage.sync.set({
      custom_recipes: [recipe("a"), recipe("b")],
      custom_recipes$: { v: 2 },
    });
    expect((await customRecipes.getValue()).map((r) => r.id)).toEqual(["a", "b"]);
    await customRecipes.migrate();
    expect(Object.keys(await browser.storage.sync.get(null)).sort()).toEqual([
      "recipe:a",
      "recipe:b",
    ]);
    expect((await customRecipes.getValue()).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("calls watch with the new and the old list", async () => {
    await customRecipes.setValue([recipe("a")]);
    const cb = vi.fn();
    const off = customRecipes.watch(cb);
    await customRecipes.setValue([recipe("a"), recipe("b")]);
    await vi.waitFor(() => expect(cb).toHaveBeenCalled());
    const [next, prev] = cb.mock.calls[0] as [Recipe[], Recipe[]];
    expect(next.map((r) => r.id)).toEqual(["a", "b"]);
    expect(prev.map((r) => r.id)).toEqual(["a"]);
    off();
  });
});
