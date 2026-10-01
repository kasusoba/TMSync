import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { isSealed, resetSecretKeyCache, seal, unseal } from "./secret";
import { sealPlainSecrets, traktTokens } from "./storage";
import type { TraktTokens } from "./trackers/trakt/types";

const tokens: TraktTokens = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "bearer",
  expires_in: 7776000,
  created_at: 1,
  scope: "public",
};

/** What `storage.local` holds for the Trakt tokens, with no decryption. */
async function stored(): Promise<unknown> {
  return (await fakeBrowser.storage.local.get("trakt_tokens")).trakt_tokens;
}

/** A browser whose site data was cleared: a new IndexedDB, so a new key. */
function loseKey(): void {
  globalThis.indexedDB = new IDBFactory();
  resetSecretKeyCache();
}

beforeEach(() => {
  fakeBrowser.reset();
  loseKey();
});

describe("seal", () => {
  it("round-trips a value and uses a new nonce each time", async () => {
    const a = await seal(tokens);
    const b = await seal(tokens);
    expect(a.iv).not.toBe(b.iv);
    expect(await unseal(a)).toEqual(tokens);
  });

  it("cannot be opened with another key", async () => {
    const sealed = await seal(tokens);
    loseKey();
    await expect(unseal(sealed)).rejects.toThrow();
  });
});

describe("secret storage items", () => {
  it("store tokens encrypted and read them back", async () => {
    await traktTokens.setValue(tokens);
    const raw = await stored();
    expect(isSealed(raw)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("access-1");
    expect(await traktTokens.getValue()).toEqual(tokens);
  });

  it("clear with null", async () => {
    await traktTokens.setValue(tokens);
    await traktTokens.setValue(null);
    expect(await stored()).toBeUndefined();
    expect(await traktTokens.getValue()).toBeNull();
  });

  it("read a lost key as disconnected", async () => {
    await traktTokens.setValue(tokens);
    loseKey();
    expect(await traktTokens.getValue()).toBeNull();
  });

  it("read plain tokens from before encryption, then seal them", async () => {
    await fakeBrowser.storage.local.set({ trakt_tokens: tokens });
    expect(await traktTokens.getValue()).toEqual(tokens);
    await sealPlainSecrets();
    expect(isSealed(await stored())).toBe(true);
    expect(await traktTokens.getValue()).toEqual(tokens);
  });

  it("pass decrypted values to watchers", async () => {
    const seen = new Promise((resolve) => traktTokens.watch((next) => resolve(next)));
    await traktTokens.setValue(tokens);
    expect(await seen).toEqual(tokens);
  });
});
