import { simklMatches, simklRatings, simklScrobbleAt, simklTokens } from "@/lib/storage";
import type { ParsedMedia } from "@tmsync/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { scrobble, scrobbleLockWait, simklKey } from "./client";
import { simklGetReview, simklRate } from "./review";

const TOKENS = {
  access_token: "a",
  refresh_token: "r",
  expires_in: 7 * 24 * 60 * 60,
  obtained_at: Math.floor(Date.now() / 1000),
};
const show: ParsedMedia = {
  mediaType: "show",
  title: "The Bear",
  season: 2,
  episode: 3,
  ids: { tmdb: 136315 },
};

beforeEach(async () => {
  fakeBrowser.reset();
  await simklTokens.setValue(TOKENS);
});
afterEach(() => vi.unstubAllGlobals());

describe("the scrobble lock", () => {
  it("gives the lock back when the call never reached Simkl", async () => {
    await simklScrobbleAt.setValue(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(scrobble("start", { progress: 1 })).rejects.toThrow("Failed to fetch");
    expect(await simklScrobbleAt.getValue()).toBe(1);
    expect(await scrobbleLockWait()).toBe(0);
  });

  it("holds the lock after a call Simkl answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 201 })),
    );
    await scrobble("start", { progress: 1 });
    expect(await scrobbleLockWait()).toBeGreaterThan(0);
  });
});

describe("the Simkl rating mirror", () => {
  it("keeps one rating for a western show across its seasons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 201 })),
    );
    expect((await simklRate(show, 8)).ok).toBe(true);
    expect((await simklGetReview({ ...show, season: 3 })).rating).toBe(8);
  });

  it("moves a rating to the Simkl id once a write names the entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 201 })),
    );
    await simklRate(show, 7);
    await simklMatches.setValue({
      [simklKey(show)]: { id: 42, section: "tv", title: "The Bear" },
    });
    expect((await simklGetReview(show)).rating).toBe(7);
    await simklRate(show, 9);
    expect(await simklRatings.getValue()).toEqual({ "simkl:42": 9 });
  });
});
