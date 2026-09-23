import { describe, expect, it } from "vitest";
import { TokenEndpointError, base64url, singleFlight } from "./oauth";

describe("base64url", () => {
  it("uses the URL-safe alphabet with no padding", () => {
    expect(base64url(new Uint8Array([251, 255, 191]))).toBe("-_-_");
    expect(base64url(new Uint8Array([1]))).toBe("AQ");
  });
});

describe("TokenEndpointError", () => {
  it("treats 400 and 401 as a lost grant, anything else as worth a retry", () => {
    expect(new TokenEndpointError("X", 400, "").grantGone).toBe(true);
    expect(new TokenEndpointError("X", 401, "").grantGone).toBe(true);
    expect(new TokenEndpointError("X", 429, "slow down").grantGone).toBe(false);
    expect(new TokenEndpointError("X", 503, "").message).toBe("X token endpoint returned 503");
  });
});

describe("singleFlight", () => {
  it("shares one in-flight call, then starts a new one", async () => {
    let calls = 0;
    let release: (v: number) => void = () => {};
    const once = singleFlight(() => {
      calls += 1;
      return new Promise<number>((r) => {
        release = r;
      });
    });
    const a = once(undefined);
    const b = once(undefined);
    release(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(calls).toBe(1);
    const c = once(undefined);
    release(8);
    expect(await c).toBe(8);
    expect(calls).toBe(2);
  });
});
