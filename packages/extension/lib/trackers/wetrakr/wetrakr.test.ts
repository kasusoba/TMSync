import { wetrakrCorrections, wetrakrResolutionCache, wetrakrTokens } from "@/lib/storage";
import type { ParsedMedia } from "@tmsync/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { buildScrobbleBody, episodeMismatch } from "./adapter";
import { readCallback } from "./auth";
import { resolve, saveCorrection, wetrakrCacheKey, yearOf } from "./client";

const show: ParsedMedia = {
  mediaType: "show",
  title: "Breaking Bad",
  season: 1,
  episode: 2,
  ids: { tmdb: 1396 },
};
const item = {
  tracker: "wetrakr" as const,
  mediaType: "show" as const,
  id: 1391953,
  title: "Breaking Bad",
};

beforeEach(async () => {
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(true);
  await wetrakrTokens.setValue({
    access_token: "a",
    refresh_token: "r",
    expires_in: 7 * 24 * 60 * 60,
    obtained_at: Math.floor(Date.now() / 1000),
  });
});
afterEach(() => vi.unstubAllGlobals());

/** A fetch that answers by path, and records each call. */
function api(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const path = new URL(url).pathname + new URL(url).search;
      const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
      return hit
        ? new Response(JSON.stringify(hit[1]), { status: 200 })
        : new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

describe("readCallback", () => {
  const ok = "https://x.chromiumapp.org/?code=abc&state=s1";

  it("returns the code when state matches", () => {
    expect(readCallback(ok, "s1")).toBe("abc");
  });

  it("rejects a wrong state and reports a cancel", () => {
    expect(() => readCallback(ok, "s2")).toThrow(/state/);
    expect(() =>
      readCallback("https://x.chromiumapp.org/?error=access_denied&state=s1", "s1"),
    ).toThrow(/cancelled/);
  });
});

describe("helpers", () => {
  it("keys a resolution by id first, else by title and year", () => {
    expect(wetrakrCacheKey(show)).toBe("show:tmdb:1396");
    expect(wetrakrCacheKey({ mediaType: "movie", title: " Heat ", year: 1995 })).toBe(
      "movie:heat:1995",
    );
  });

  it("reads a year from an ISO date", () => {
    expect(yearOf("2008-01-20T00:00:00.000Z")).toBe(2008);
    expect(yearOf(undefined)).toBeUndefined();
  });
});

describe("buildScrobbleBody", () => {
  it("sends the show by WeTrakr id with the page's season and episode", () => {
    expect(buildScrobbleBody(item, show, 12.3456, "2.10.0")).toEqual({
      show: { id: 1391953 },
      episode: { season: 1, number: 2 },
      progress: 12.35,
      app_version: "2.10.0",
    });
  });

  it("needs both a season and an episode for a show", () => {
    expect(buildScrobbleBody(item, { ...show, season: undefined }, 5, "1")).toBeNull();
  });

  it("sends a movie by id", () => {
    const movie = { ...item, mediaType: "movie" as const, id: 126 };
    expect(buildScrobbleBody(movie, { mediaType: "movie", title: "x" }, 50, "1")).toEqual({
      movie: { id: 126 },
      progress: 50,
      app_version: "1",
    });
  });
});

describe("episodeMismatch", () => {
  const body = buildScrobbleBody(item, show, 10, "1");
  if (!body) throw new Error("no body");

  it("passes when WeTrakr matched the episode sent", () => {
    const reply = {
      action: "start" as const,
      progress: 10,
      episode: { id: 1, season_number: 1, number: 2 },
    };
    expect(episodeMismatch(body, reply)).toBeNull();
  });

  it("names what WeTrakr matched when it differs", () => {
    const reply = {
      action: "start" as const,
      progress: 10,
      episode: { id: 1, season_number: 2, number: 5 },
    };
    expect(episodeMismatch(body, reply)).toMatch(/matched S2E5, not S1E2/);
  });

  it("passes when the reply names no episode", () => {
    expect(episodeMismatch(body, { action: "pause", progress: 10 })).toBeNull();
  });
});

describe("resolve", () => {
  it("looks up a page id exactly, then reads the title, and caches it", async () => {
    const calls = api({
      "/media/external/tmdb/1396?type=show": { id: 1391953, type: "show" },
      "/shows/1391953": {
        id: 1391953,
        type: "show",
        title: "Breaking Bad",
        first_air_date: "2008-01-20T00:00:00.000Z",
        ids: { tmdb: 1396, imdb: "tt0903747" },
      },
    });
    const identity = { mediaType: "show", id: 1391953, title: "Breaking Bad", year: 2008 };
    expect(await resolve(show)).toEqual(identity);
    expect((await wetrakrResolutionCache.getValue())["show:tmdb:1396"]).toEqual(identity);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["wetrakr-api-version"]).toBe("1");
    expect(headers.Authorization).toBe("Bearer a");
  });

  it("does not fall back to a title search when the id is unknown", async () => {
    const calls = api({});
    expect(await resolve(show)).toBeNull();
    expect(calls.some((c) => c.url.includes("/search"))).toBe(false);
  });

  it("uses a movie's year to pick among title hits", async () => {
    api({
      "/search?": [
        { id: 1, type: "movie", title: "Heat", release_date: "1986-01-01" },
        { id: 2, type: "movie", title: "Heat", release_date: "1995-12-15" },
      ],
    });
    expect((await resolve({ mediaType: "movie", title: "Heat", year: 1995 }))?.id).toBe(2);
  });

  it("returns a user fix before anything else", async () => {
    const fix = { mediaType: "show" as const, id: 7, title: "Fixed" };
    await saveCorrection(show, fix);
    const calls = api({});
    expect(await resolve(show)).toEqual(fix);
    expect(calls).toHaveLength(0);
    expect(await wetrakrCorrections.getValue()).toHaveProperty("show:tmdb:1396");
  });
});
