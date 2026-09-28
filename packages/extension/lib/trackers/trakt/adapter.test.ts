import type { ParsedMedia } from "@tmsync/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackedItem } from "../types";

// Mock the network seams: the adapter's own logic is what's under test.
const { isConnected } = vi.hoisted(() => ({ isConnected: vi.fn() }));
vi.mock("./auth", () => ({ isConnected }));
const { resolve, scrobble, watchedProgress } = vi.hoisted(() => ({
  resolve: vi.fn(),
  scrobble: vi.fn(),
  watchedProgress: vi.fn(),
}));
vi.mock("./client", async (orig) => ({
  ...(await orig<typeof import("./client")>()),
  resolve,
  scrobble,
  watchedProgress,
}));

import { traktAdapter } from "./adapter";
import { TraktNotConnectedError } from "./client";

const show: TrackedItem = { tracker: "trakt", mediaType: "show", id: 1, title: "Show" };
const movie: TrackedItem = { tracker: "trakt", mediaType: "movie", id: 2, title: "Film" };
const ep: ParsedMedia = { mediaType: "show", title: "Show", season: 1, episode: 3 };

beforeEach(() => vi.clearAllMocks());

describe("traktAdapter.resolve", () => {
  it("maps the Trakt identity to a seam item", async () => {
    resolve.mockResolvedValue({ mediaType: "show", traktId: 1, title: "Show", year: 2020 });
    expect(await traktAdapter.resolve(ep)).toEqual({
      tracker: "trakt",
      mediaType: "show",
      id: 1,
      title: "Show",
      year: 2020,
    });
  });

  it("returns null when Trakt has no match", async () => {
    resolve.mockResolvedValue(null);
    expect(await traktAdapter.resolve(ep)).toBeNull();
  });
});

describe("traktAdapter.recordProgress", () => {
  it("scrobbles the scraped episode with the clamped progress", async () => {
    scrobble.mockResolvedValue({ ok: true, status: 201, action: "scrobble" });
    const r = await traktAdapter.recordProgress(show, ep, 91.23456, "stop");
    expect(scrobble).toHaveBeenCalledWith("stop", {
      show: { ids: { trakt: 1 } },
      episode: { season: 1, number: 3 },
      progress: 91.23,
    });
    expect(r).toMatchObject({ ok: true, action: "scrobble" });
  });

  it("refuses a show with no episode number", async () => {
    const r = await traktAdapter.recordProgress(show, { ...ep, episode: undefined }, 50, "start");
    expect(r).toEqual({ ok: false, reason: "no_episode" });
    expect(scrobble).not.toHaveBeenCalled();
  });

  it("skips a pause at or under Trakt's 1% floor", async () => {
    const r = await traktAdapter.recordProgress(
      movie,
      { mediaType: "movie", title: "Film" },
      0.996,
      "pause",
    );
    expect(r).toEqual({ ok: true });
    expect(scrobble).not.toHaveBeenCalled();
  });

  it("reports not_connected instead of throwing", async () => {
    scrobble.mockRejectedValue(new TraktNotConnectedError());
    expect(await traktAdapter.recordProgress(show, ep, 50, "start")).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  it("reports an HTTP failure with Trakt's error", async () => {
    scrobble.mockResolvedValue({ ok: false, status: 422, error: "bad progress" });
    expect(await traktAdapter.recordProgress(show, ep, 50, "start")).toMatchObject({
      ok: false,
      reason: "http",
      status: 422,
      httpError: "bad progress",
    });
  });

  it("rejects an item from another tracker", async () => {
    const other: TrackedItem = { tracker: "simkl", mediaType: "show", id: 9, title: "X" };
    expect(await traktAdapter.recordProgress(other, ep, 50, "start")).toEqual({
      ok: false,
      reason: "unresolved",
    });
  });
});

describe("traktAdapter.ratingLevels", () => {
  it("rates a show at episode, season, and show level", () => {
    expect(traktAdapter.ratingLevels(ep)).toEqual(["episode", "season", "show"]);
  });

  it("rates a movie once", () => {
    expect(traktAdapter.ratingLevels({ mediaType: "movie", title: "Film" })).toEqual(["movie"]);
  });
});

describe("traktAdapter.watchedState", () => {
  it("takes the last watched episode by time, not by number, and flags a gap", async () => {
    watchedProgress.mockResolvedValue({
      aired: 10,
      completed: 3,
      next_episode: { season: 1, number: 2 },
      seasons: [
        {
          number: 1,
          episodes: [
            { number: 1, completed: true, last_watched_at: "2026-01-01T00:00:00Z" },
            { number: 2, completed: false },
            { number: 5, completed: true, last_watched_at: "2026-01-03T00:00:00Z" },
            // A rewatch of an earlier episode, most recent of all.
            { number: 3, completed: true, last_watched_at: "2026-01-05T00:00:00Z" },
          ],
        },
      ],
    });
    expect(await traktAdapter.watchedState(show)).toEqual({
      tracker: "trakt",
      total: 10,
      watchedCount: 3,
      lastWatched: { season: 1, number: 3 },
      next: { season: 1, number: 2 },
      hasGaps: true,
    });
  });

  it("has no episode state for a movie", async () => {
    expect(await traktAdapter.watchedState(movie)).toBeNull();
    expect(watchedProgress).not.toHaveBeenCalled();
  });

  it("returns null when not connected", async () => {
    watchedProgress.mockRejectedValue(new TraktNotConnectedError());
    expect(await traktAdapter.watchedState(show)).toBeNull();
  });
});
