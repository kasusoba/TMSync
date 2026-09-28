import { traktTokens } from "@/lib/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { refreshTokens } from "./auth";
import type { TraktTokens } from "./types";

const OLD: TraktTokens = {
  access_token: "old-access",
  refresh_token: "old-refresh",
  token_type: "bearer",
  expires_in: 86400,
  scope: "public",
  created_at: 0,
};
const NEW: TraktTokens = { ...OLD, access_token: "new-access", refresh_token: "new-refresh" };

describe("refreshTokens", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.spyOn(fakeBrowser.identity, "getRedirectURL").mockReturnValue("https://id.example/");
    await traktTokens.setValue(OLD);
  });
  afterEach(() => vi.unstubAllGlobals());

  // Trakt accepts a refresh token once. Two parallel refreshes used to send it
  // twice; the loser cleared the tokens and signed the user out.
  it("shares one refresh between concurrent callers", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(NEW), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const [a, b] = await Promise.all([refreshTokens(), refreshTokens()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(NEW);
    expect(b).toEqual(NEW);
    expect(await traktTokens.getValue()).toEqual(NEW);
  });

  it("keeps the tokens on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await refreshTokens()).toBeNull();
    expect(await traktTokens.getValue()).toEqual(OLD);
  });

  it("keeps the tokens on a server error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    expect(await refreshTokens()).toBeNull();
    expect(await traktTokens.getValue()).toEqual(OLD);
  });

  it("signs out when Trakt refuses the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    expect(await refreshTokens()).toBeNull();
    expect(await traktTokens.getValue()).toBeNull();
  });
});
