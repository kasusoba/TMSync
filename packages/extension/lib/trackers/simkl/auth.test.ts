import { simklTokens } from "@/lib/storage";
import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { canWrite, codeChallenge, getValidAccessToken, readCallback, staleRefresh } from "./auth";
import type { SimklTokens } from "./types";

describe("codeChallenge", () => {
  it("is base64url(SHA-256(verifier)), unpadded", async () => {
    // Expected value from: printf '%s' <verifier> | openssl dgst -sha256 -binary | base64url
    expect(await codeChallenge("tmsync-pkce-test-verifier-0123456789-abcdefgh")).toBe(
      "1hzxyT5PKPOv5EMEiJHoZCMjDUSuD0PDM50caW3ENlc",
    );
  });
});

describe("readCallback", () => {
  const ok = "https://x.chromiumapp.org/?code=abc&state=s1&iss=https%3A%2F%2Fsimkl.com";

  it("returns the code when state and iss match", () => {
    expect(readCallback(ok, "s1")).toBe("abc");
  });

  it("rejects a wrong issuer (mix-up) or state (CSRF)", () => {
    expect(() => readCallback(ok.replace("simkl.com", "evil.com"), "s1")).toThrow(/Simkl/);
    expect(() => readCallback(ok, "s2")).toThrow(/state/);
  });

  it("reports a cancelled consent", () => {
    const denied =
      "https://x.chromiumapp.org/?error=access_denied&state=s1&iss=https%3A%2F%2Fsimkl.com";
    expect(() => readCallback(denied, "s1")).toThrow(/cancelled/);
  });
});

describe("canWrite", () => {
  it("needs media:write in the granted scope", () => {
    expect(canWrite("media:read media:write")).toBe(true);
    expect(canWrite("media:read")).toBe(false);
    expect(canWrite(undefined)).toBe(false);
  });
});

describe("staleRefresh", () => {
  const old: SimklTokens = {
    access_token: "a",
    refresh_token: "r-old",
    expires_in: 604800,
    obtained_at: 0,
  };

  it("revokes the old grant after a re-connect gives a new one", () => {
    expect(staleRefresh(old, "r-new")).toBe("r-old");
  });

  it("keeps a grant that Simkl handed back unchanged, and a first connect", () => {
    expect(staleRefresh(old, "r-old")).toBeNull();
    expect(staleRefresh(null, "r-new")).toBeNull();
  });
});

describe("getValidAccessToken", () => {
  it("does not refresh a fresh token that lasts less than a day", async () => {
    fakeBrowser.reset();
    const now = Math.floor(Date.now() / 1000);
    await simklTokens.setValue({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      obtained_at: now,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await getValidAccessToken()).toBe("a");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
