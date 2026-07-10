import type { ParsedMedia } from "@tmsync/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackedItem } from "../tracker/types";

// Mock the auth seam so we can toggle connection without real tokens/storage.
const { isConnected } = vi.hoisted(() => ({ isConnected: vi.fn() }));
vi.mock("./auth", () => ({ isConnected }));

import { anilistAdapter } from "./adapter";

const item: TrackedItem = {
  tracker: "anilist",
  mediaType: "show",
  id: 1,
  title: "Frieren",
  year: 2023,
  episodes: 12,
};
const media: ParsedMedia = { mediaType: "show", title: "Frieren", episode: 3 };

describe("anilistAdapter.recordProgress connection gate", () => {
  beforeEach(() => isConnected.mockReset());

  // The bug this guards: AniList has no scrobble API, so start/pause used to return
  // ok unconditionally — the badge showed "watching"/"paused" for a whole episode
  // and only errored "connect AniList" at the threshold write. Now the not-connected
  // state surfaces on the first play/pause event.
  it("returns not_connected on play when AniList is not connected", async () => {
    isConnected.mockResolvedValue(false);
    expect(await anilistAdapter.recordProgress(item, media, 0.1, "start", 0.8)).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  it("returns not_connected on pause when AniList is not connected", async () => {
    isConnected.mockResolvedValue(false);
    expect(await anilistAdapter.recordProgress(item, media, 0.5, "pause", 0.8)).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  it("is a silent no-op on play/pause when connected (no write before the threshold)", async () => {
    isConnected.mockResolvedValue(true);
    expect(await anilistAdapter.recordProgress(item, media, 0.1, "start", 0.8)).toEqual({
      ok: true,
    });
    expect(await anilistAdapter.recordProgress(item, media, 0.5, "pause", 0.8)).toEqual({
      ok: true,
    });
  });
});
