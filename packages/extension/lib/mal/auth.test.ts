import { malTokens } from "@/lib/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { codeVerifier, getValidAccessToken, refreshAfterReject } from "./auth";
import type { MalTokens } from "./types";

const now = () => Math.floor(Date.now() / 1000);
const EXPIRED: MalTokens = {
  access_token: "old-access",
  refresh_token: "old-refresh",
  expires_in: 3600,
  obtained_at: now() - 7200,
};
const FRESH_BODY = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 2415600,
};

describe("codeVerifier", () => {
  it("is 43 to 128 unreserved characters and new every time", () => {
    const a = codeVerifier();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(a).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(codeVerifier()).not.toBe(a);
  });
});

describe("MAL token refresh", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await malTokens.setValue(EXPIRED);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns a live token without calling the network", async () => {
    await malTokens.setValue({ ...EXPIRED, obtained_at: now() });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await getValidAccessToken()).toBe("old-access");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and stores the rotated refresh token", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as URLSearchParams);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh");
      expect(body.has("client_secret")).toBe(false);
      return new Response(JSON.stringify(FRESH_BODY), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await getValidAccessToken()).toBe("new-access");
    expect((await malTokens.getValue())?.refresh_token).toBe("new-refresh");
  });

  it("shares one refresh between concurrent callers", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(FRESH_BODY), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const [a, b] = await Promise.all([getValidAccessToken(), refreshAfterReject()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe("new-access");
    expect(b).toBe("new-access");
  });

  it("keeps the tokens on a network or server error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    expect(await getValidAccessToken()).toBeNull();
    expect(await malTokens.getValue()).toEqual(EXPIRED);
  });

  it("signs out when MAL refuses the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 400 })),
    );
    expect(await getValidAccessToken()).toBeNull();
    expect(await malTokens.getValue()).toBeNull();
  });
});
