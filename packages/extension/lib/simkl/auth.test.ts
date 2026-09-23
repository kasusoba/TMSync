import { describe, expect, it } from "vitest";
import { canWrite, codeChallenge, readCallback } from "./auth";

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
