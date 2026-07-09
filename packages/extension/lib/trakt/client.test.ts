import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrobble } from "./client";
import type { ScrobbleBody } from "./types";

// scrobble() only needs a token to reach the network; mock auth so api() doesn't
// throw TraktNotConnectedError and never touches real OAuth/storage.
vi.mock("./auth", () => ({
  getValidAccessToken: vi.fn(async () => "test-token"),
  refreshTokens: vi.fn(async () => null),
}));

const EPISODE: ScrobbleBody = {
  show: { ids: { trakt: 1 } },
  episode: { season: 1, number: 10 },
  progress: 0.9,
};

/** Stub global fetch with one canned Response for the next scrobble call. */
function respondWith(status: number, body = ""): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

describe("scrobble", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("swallows a pause under Trakt's 1% floor (422) as a no-op success", async () => {
    respondWith(422, '{"message":"Progress should be at least 1.0% to pause."}');
    expect(await scrobble("pause", EPISODE)).toEqual({ ok: true, status: 422 });
  });

  it("does NOT swallow a 422 on start or stop — a real failure still surfaces", async () => {
    respondWith(422, '{"message":"validation errors"}');
    const stop = await scrobble("stop", EPISODE);
    expect(stop.ok).toBe(false);
    expect(stop.status).toBe(422);

    respondWith(422, '{"message":"validation errors"}');
    const start = await scrobble("start", EPISODE);
    expect(start.ok).toBe(false);
    expect(start.status).toBe(422);
  });

  it("treats a 409 (already scrobbling) as a no-op success for any action", async () => {
    respondWith(409);
    expect(await scrobble("start", EPISODE)).toEqual({ ok: true, status: 409 });
  });

  it("surfaces other HTTP failures with the truncated error body", async () => {
    respondWith(500, "internal error");
    const out = await scrobble("start", EPISODE);
    expect(out).toMatchObject({ ok: false, status: 500, error: "internal error" });
  });

  it("returns the echoed action on success", async () => {
    respondWith(201, JSON.stringify({ action: "scrobble" }));
    expect(await scrobble("stop", EPISODE)).toEqual({
      ok: true,
      status: 201,
      action: "scrobble",
    });
  });
});
