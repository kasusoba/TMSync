import type { ParsedMedia } from "@tmsync/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackedItem } from "../types";

// Mock the network and storage seams: the adapter's own logic is what's under test.
const { isConnected } = vi.hoisted(() => ({ isConnected: vi.fn() }));
vi.mock("./auth", () => ({ isConnected }));
const { scrobble, getMatch, saveMatch } = vi.hoisted(() => ({
  scrobble: vi.fn(),
  getMatch: vi.fn(),
  saveMatch: vi.fn(),
}));
vi.mock("./client", async (orig) => ({
  ...(await orig<typeof import("./client")>()),
  scrobble,
  getMatch,
  saveMatch,
}));

import { simklAdapter } from "./adapter";
import { SimklNotConnectedError } from "./client";

const ep: ParsedMedia = {
  mediaType: "show",
  title: "Show",
  year: 2020,
  season: 1,
  episode: 3,
  ids: { tmdb: 100 },
};
const item: TrackedItem = { tracker: "simkl", mediaType: "show", id: 0, title: "Show" };

beforeEach(() => {
  vi.clearAllMocks();
  isConnected.mockResolvedValue(true);
});

describe("simklAdapter.resolve", () => {
  it("builds the item from the page before any write (id 0, no network)", async () => {
    getMatch.mockResolvedValue(undefined);
    expect(await simklAdapter.resolve(ep)).toEqual({
      tracker: "simkl",
      mediaType: "show",
      id: 0,
      title: "Show",
      year: 2020,
      url: undefined,
    });
  });

  it("uses Simkl's own id, title, and page once a write has named them", async () => {
    getMatch.mockResolvedValue({ id: 42, section: "tv", title: "The Show", year: 2019 });
    expect(await simklAdapter.resolve(ep)).toMatchObject({
      id: 42,
      title: "The Show",
      year: 2019,
      url: "https://simkl.com/tv/42",
    });
  });
});

describe("simklAdapter.recordProgress", () => {
  it("scrobbles and saves the match Simkl returns", async () => {
    const match = { id: 42, section: "tv", title: "The Show" };
    scrobble.mockResolvedValue({ kind: "ok", action: "scrobble", match });
    const r = await simklAdapter.recordProgress(item, ep, 90, "stop");
    expect(scrobble.mock.calls[0]?.[0]).toBe("stop");
    expect(saveMatch).toHaveBeenCalledWith(ep, match);
    expect(r).toEqual({ ok: true, action: "scrobble" });
  });

  it("reports a checkin as a start", async () => {
    scrobble.mockResolvedValue({ kind: "ok", action: "checkin", match: null });
    expect(await simklAdapter.recordProgress(item, ep, 5, "start")).toEqual({
      ok: true,
      action: "start",
    });
    expect(saveMatch).not.toHaveBeenCalled();
  });

  it("checks the connection before it spends quota", async () => {
    isConnected.mockResolvedValue(false);
    expect(await simklAdapter.recordProgress(item, ep, 50, "start")).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(scrobble).not.toHaveBeenCalled();
  });

  it("refuses a show with no episode number", async () => {
    const r = await simklAdapter.recordProgress(item, { ...ep, episode: undefined }, 50, "start");
    expect(r).toEqual({ ok: false, reason: "no_episode" });
  });

  it("treats a dropped start inside the lock as success", async () => {
    scrobble.mockResolvedValue({ kind: "skipped" });
    expect(await simklAdapter.recordProgress(item, ep, 50, "start")).toEqual({ ok: true });
  });

  it("treats an already recorded watch as scrobbled", async () => {
    scrobble.mockResolvedValue({ kind: "already_recorded" });
    expect(await simklAdapter.recordProgress(item, ep, 90, "stop")).toEqual({
      ok: true,
      action: "scrobble",
    });
  });

  it("explains a used-up daily quota", async () => {
    scrobble.mockResolvedValue({ kind: "failed", status: 429 });
    const r = await simklAdapter.recordProgress(item, ep, 90, "stop");
    expect(r).toMatchObject({ ok: false, reason: "http", status: 429 });
    expect(r.httpError).toMatch(/daily request limit/);
  });

  it("reports an item Simkl can't find as unresolved", async () => {
    scrobble.mockResolvedValue({ kind: "not_found" });
    expect(await simklAdapter.recordProgress(item, ep, 90, "stop")).toMatchObject({
      ok: false,
      reason: "unresolved",
    });
  });

  it("maps a lost connection mid-call to not_connected", async () => {
    scrobble.mockRejectedValue(new SimklNotConnectedError());
    expect(await simklAdapter.recordProgress(item, ep, 90, "stop")).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });
});

describe("simklAdapter", () => {
  it("rates the whole entry only", () => {
    expect(simklAdapter.ratingLevels(ep)).toEqual(["show"]);
    expect(simklAdapter.ratingLevels({ mediaType: "movie", title: "Film" })).toEqual(["movie"]);
  });

  it("never reads progress back (it would spend the shared daily quota)", async () => {
    expect(await simklAdapter.watchedState(item)).toBeNull();
    expect(scrobble).not.toHaveBeenCalled();
  });
});
