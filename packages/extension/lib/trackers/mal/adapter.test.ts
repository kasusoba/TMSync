import { malCorrections, malResolutionCache } from "@/lib/storage";
import type { ParsedMedia } from "@tmsync/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { malAdapter, planToFields } from "./adapter";
import { malCacheKey } from "./client";

describe("planToFields", () => {
  it("writes a first watch as watching", () => {
    expect(
      planToFields({ kind: "write", progress: 3, status: "CURRENT", completed: false }),
    ).toEqual({ status: "watching", num_watched_episodes: 3 });
  });

  it("completes the entry and clears any rewatch flag", () => {
    expect(
      planToFields({ kind: "write", progress: 12, status: "COMPLETED", completed: true }),
    ).toEqual({ status: "completed", is_rewatching: false, num_watched_episodes: 12 });
  });

  it("marks a rewatch as completed + is_rewatching (MAL has no REPEATING status)", () => {
    expect(
      planToFields({ kind: "write", progress: 2, status: "REPEATING", completed: false }),
    ).toEqual({ status: "completed", is_rewatching: true, num_watched_episodes: 2 });
  });

  it("bumps the rewatch count when a rewatch finishes", () => {
    expect(
      planToFields({
        kind: "write",
        progress: 12,
        status: "COMPLETED",
        repeat: 1,
        completed: true,
      }),
    ).toEqual({
      status: "completed",
      is_rewatching: false,
      num_watched_episodes: 12,
      num_times_rewatched: 1,
    });
  });
});

describe("malAdapter.resolveById", () => {
  beforeEach(() => fakeBrowser.reset());
  afterEach(() => vi.unstubAllGlobals());

  const page: ParsedMedia = { mediaType: "show", title: "Frieren", episode: 3 };

  it("lets a MAL title pin win over the id AniList bridges to", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await malCorrections.setValue({
      [malCacheKey(page)]: { id: 52991, title: "Frieren", episodes: 28 },
    });
    const item = await malAdapter.resolveById?.({ mal: 1 }, page);
    expect(item?.id).toBe(52991);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips MAL when the pin says it's not on MyAnimeList", async () => {
    await malCorrections.setValue({ [malCacheKey(page)]: null });
    expect(await malAdapter.resolveById?.({ mal: 1 }, page)).toBeNull();
  });

  it("ignores a title pin from another season on a tmdb page", async () => {
    await malResolutionCache.setValue({
      "id:1": { id: 1, title: "Season 3", episodes: 10, at: 0 },
    });
    // Pinned on a site with no season number: the key has no season.
    await malCorrections.setValue({
      [malCacheKey({ ...page, year: 2013 })]: { id: 16498, title: "Season 1", episodes: 25 },
    });
    // The crosswalk removes the season from a tmdb page's media.
    const derived: ParsedMedia = { ...page, year: 2013, ids: { tmdb: 1429 } };
    const item = await malAdapter.resolveById?.({ mal: 1 }, derived);
    expect(item?.id).toBe(1);
  });
});
