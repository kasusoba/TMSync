import { wetrakrNotes, wetrakrTokens } from "@/lib/storage";
import type { ParsedMedia } from "@tmsync/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { itemPath, ratingBody } from "./client";
import { progressFrom, wetrakrReviewKey, wetrakrSaveNote } from "./review";

const bb = { mediaType: "show" as const, id: 1391953, title: "Breaking Bad" };
const media: ParsedMedia = {
  mediaType: "show",
  title: "Breaking Bad",
  season: 1,
  episode: 2,
  ids: { tmdb: 1396 },
};

beforeEach(async () => {
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(true);
  await wetrakrTokens.setValue({
    access_token: "a",
    refresh_token: "r",
    expires_in: 604800,
    obtained_at: Math.floor(Date.now() / 1000),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("levels", () => {
  it("keys each level on its own", () => {
    expect(wetrakrReviewKey(bb, "show", 1, 2)).toBe("show:1391953::");
    expect(wetrakrReviewKey(bb, "episode", 1, 2)).toBe("episode:1391953:1:2");
  });

  it("builds the item path for a level", () => {
    expect(itemPath(bb, "season", 1)).toBe("/shows/1391953/seasons/1");
    expect(itemPath(bb, "episode", 1, 2)).toBe("/shows/1391953/seasons/1/episodes/2");
    expect(itemPath(bb, "episode", 1)).toBeNull();
  });

  it("nests a season or episode rating under the show", () => {
    expect(ratingBody(bb, "episode", 1, 2, 9)).toEqual({
      shows: [{ id: 1391953, seasons: [{ number: 1, episodes: [{ number: 2, rating: 9 }] }] }],
    });
    expect(ratingBody(bb, "show", undefined, undefined)).toEqual({ shows: [{ id: 1391953 }] });
  });
});

describe("progressFrom", () => {
  const ep = (number: number, status?: string, at?: string) => ({
    number,
    air_date: "2020-01-01",
    interactions: status ? { user: { tracking: { last: { status, last_watched_at: at } } } } : {},
  });

  it("counts aired and watched episodes and finds the next one", () => {
    const state = progressFrom([
      {
        season: 1,
        episodes: [ep(1, "watched", "2026-01-01"), ep(2, "watched", "2026-01-02"), ep(3)],
      },
      { season: 2, episodes: [{ number: 1, air_date: "2999-01-01", interactions: {} }] },
    ]);
    expect(state).toMatchObject({
      total: 3,
      watchedCount: 2,
      lastWatched: { season: 1, number: 2 },
      next: { season: 1, number: 3 },
      hasGaps: false,
    });
  });

  it("flags a gap when the next episode is before the last one watched", () => {
    const state = progressFrom([{ season: 1, episodes: [ep(1), ep(2, "watched", "2026-01-01")] }]);
    expect(state.next).toEqual({ season: 1, number: 1 });
    expect(state.hasGaps).toBe(true);
  });
});

describe("wetrakrSaveNote", () => {
  it("posts the new comment before it deletes the old one", async () => {
    const key = "episode:1391953:1:2";
    await wetrakrNotes.setValue({ [key]: { commentId: 5, text: "old", spoiler: false } });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path.startsWith("/media/external")) return Response.json({ id: 1391953, type: "show" });
        if (path === "/shows/1391953")
          return Response.json({ id: 1391953, type: "show", title: "Breaking Bad" });
        if (path === "/shows/1391953/seasons/1/episodes/2") return Response.json({ id: 174659 });
        if (path === "/sync/comments") return Response.json({ id: 9 }, { status: 201 });
        return Response.json({});
      }),
    );
    expect(await wetrakrSaveNote(media, "episode", "new text", true)).toEqual({ ok: true });
    const post = calls.indexOf("POST /sync/comments");
    expect(post).toBeGreaterThan(-1);
    expect(calls.indexOf("DELETE /sync/comments/5")).toBeGreaterThan(post);
    expect((await wetrakrNotes.getValue())[key]).toEqual({
      commentId: 9,
      text: "new text",
      spoiler: true,
    });
  });
});
