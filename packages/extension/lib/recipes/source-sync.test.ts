import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { quickLinks, recipeSources, siteSourcePins, sourceCaches } from "../storage";
import {
  applySourceLinks,
  migrateFromLibrary,
  pruneSourceCaches,
  refreshSources,
} from "./source-sync";

const recipe = {
  id: "x-movie",
  schemaVersion: 2,
  name: "X",
  match: { urlPattern: "/movie", hostnames: ["x.to"] },
  extract: { title: { source: "title" } },
};
const link = { id: "x", name: "X", host: "x.to", movie: "/m/{tmdb}" };
const file = { name: "Mine", recipes: [recipe, { id: "bad" }], links: [link] };

const fetchMock = vi.fn();
const reply = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), init);

beforeEach(() => {
  fakeBrowser.reset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const source = (id: string, enabled = true) => ({
  id,
  url: `https://example.org/${id}.json`,
  enabled,
});

describe("refreshSources", () => {
  it("keeps the valid recipes, the name, and the links (off)", async () => {
    await recipeSources.setValue([source("a")]);
    fetchMock.mockResolvedValue(reply(file, { headers: { ETag: '"v1"' } }));
    const out = await refreshSources();
    expect(out).toEqual({ ok: true, count: 1 });
    const cache = (await sourceCaches.getValue()).a;
    expect(cache?.name).toBe("Mine");
    expect(cache?.etag).toBe('"v1"');
    expect(cache?.recipes.map((r) => r.id)).toEqual(["x-movie"]);
    expect(await quickLinks.getValue()).toMatchObject([
      { id: "x", enabled: false, source: "source", sourceId: "a" },
    ]);
  });

  it("skips a fresh copy unless forced, and sends the ETag with host access", async () => {
    vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(true);
    await recipeSources.setValue([source("a")]);
    fetchMock.mockResolvedValue(reply(file, { headers: { ETag: '"v1"' } }));
    await refreshSources();
    await refreshSources();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(new Response(null, { status: 304 }));
    await refreshSources({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "If-None-Match": '"v1"' });
    expect((await sourceCaches.getValue()).a?.recipes).toHaveLength(1);
  });

  it("sends no ETag to a host read by CORS alone (it would force a preflight)", async () => {
    vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(false);
    await recipeSources.setValue([source("a")]);
    fetchMock.mockImplementation(async () => reply(file, { headers: { ETag: '"v1"' } }));
    await refreshSources();
    await refreshSources({ force: true });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toBeUndefined();
  });

  it("marks the first good read, not a failed first try", async () => {
    await recipeSources.setValue([source("a")]);
    fetchMock.mockResolvedValue(reply("down", { status: 503 }));
    await refreshSources();
    expect((await sourceCaches.getValue()).a?.okAt).toBeUndefined();
    fetchMock.mockResolvedValue(reply(file));
    await refreshSources({ force: true });
    expect((await sourceCaches.getValue()).a?.okAt).toBeTypeOf("number");
  });

  it("writes no copy for a source removed during its fetch", async () => {
    await recipeSources.setValue([source("a")]);
    fetchMock.mockImplementation(async () => {
      await recipeSources.setValue([]);
      return reply(file);
    });
    await refreshSources();
    expect(await sourceCaches.getValue()).toEqual({});
  });

  it("keeps the last good copy when a fetch fails, and records why", async () => {
    await recipeSources.setValue([source("a")]);
    fetchMock.mockResolvedValue(reply(file));
    await refreshSources();
    fetchMock.mockResolvedValue(reply("nope", { status: 404 }));
    const out = await refreshSources({ force: true });
    expect(out).toEqual({ ok: false, count: 1, error: "HTTP 404" });
    const cache = (await sourceCaches.getValue()).a;
    expect(cache?.recipes).toHaveLength(1);
    expect(cache?.error).toBe("HTTP 404");
  });

  it("refuses a file that is too large or not JSON", async () => {
    await recipeSources.setValue([source("a"), source("b")]);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/a.") ? reply("x".repeat(1_000_001)) : reply("{oops"),
    );
    await refreshSources();
    const caches = await sourceCaches.getValue();
    expect(caches.a?.error).toBe("The file is too large.");
    expect(caches.b?.error).toBe("The file is not JSON.");
  });

  it("skips turned-off sources, and pruning drops the copies of removed ones", async () => {
    await recipeSources.setValue([source("b", false)]);
    const copy = { recipes: [], links: [], fetchedAt: 1 };
    await sourceCaches.setValue({ gone: copy, b: copy });
    await refreshSources();
    expect(fetchMock).not.toHaveBeenCalled();
    await pruneSourceCaches();
    expect(await sourceCaches.getValue()).toEqual({ b: copy });
  });
});

describe("applySourceLinks", () => {
  it("keeps the user's on/off, removes links no source offers, never touches user links", async () => {
    await recipeSources.setValue([source("a")]);
    await sourceCaches.setValue({ a: { recipes: [], links: [link] as never, fetchedAt: 1 } });
    await quickLinks.setValue([
      { ...link, enabled: true, source: "source", sourceId: "a", movie: "/old/{tmdb}" },
      { id: "old", name: "Old", enabled: true, source: "source", sourceId: "a" },
      { id: "mine", name: "Mine", enabled: true, source: "user" },
    ]);
    await applySourceLinks();
    expect(await quickLinks.getValue()).toEqual([
      expect.objectContaining({ id: "x", enabled: true, movie: "/m/{tmdb}" }),
      { id: "mine", name: "Mine", enabled: true, source: "user" },
    ]);
  });

  it("follows a site pin to the other source's link", async () => {
    await recipeSources.setValue([source("a"), source("b")]);
    await sourceCaches.setValue({
      a: { recipes: [], links: [{ ...link, id: "xa" }] as never, fetchedAt: 1 },
      b: { recipes: [], links: [{ ...link, id: "xb" }] as never, fetchedAt: 1 },
    });
    await applySourceLinks();
    expect((await quickLinks.getValue()).map((l) => l.id)).toEqual(["xa"]);
    await siteSourcePins.setValue({ "x.to": "b" });
    await applySourceLinks();
    expect((await quickLinks.getValue()).map((l) => l.id)).toEqual(["xb"]);
  });
});

describe("applySourceLinks across a source turned off and on", () => {
  it("brings the links back with the user's on/off", async () => {
    await recipeSources.setValue([source("a")]);
    await sourceCaches.setValue({ a: { recipes: [], links: [link] as never, fetchedAt: 1 } });
    await applySourceLinks();
    await quickLinks.setValue((await quickLinks.getValue()).map((l) => ({ ...l, enabled: true })));
    await recipeSources.setValue([source("a", false)]);
    await applySourceLinks();
    expect(await quickLinks.getValue()).toEqual([]);
    await recipeSources.setValue([source("a")]);
    await applySourceLinks();
    expect(await quickLinks.getValue()).toMatchObject([{ id: "x", enabled: true }]);
  });
});

describe("migrateFromLibrary", () => {
  it("keeps old library links as the user's own and drops the old cache", async () => {
    await fakeBrowser.storage.local.set({ remote_recipes: { recipes: [] } });
    await quickLinks.setValue([
      { id: "l", name: "L", enabled: true, source: "library" as never },
      { id: "u", name: "U", enabled: false, source: "user" },
    ]);
    await migrateFromLibrary();
    expect((await quickLinks.getValue()).map((l) => l.source)).toEqual(["user", "user"]);
    expect(await fakeBrowser.storage.local.get("remote_recipes")).toEqual({});
  });
});
