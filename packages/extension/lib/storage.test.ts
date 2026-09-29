import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { listSyncSettings } from "./storage";
import { DEFAULT_SYNC_SETTINGS } from "./sync/types";

describe("listSyncSettings", () => {
  beforeEach(() => fakeBrowser.reset());

  it("keeps the ignore list and auto sync on this device, the rest synced", async () => {
    await listSyncSettings.setValue({
      ...DEFAULT_SYNC_SETTINGS,
      includeAdult: true,
      ignore: ["mal:1"],
      auto: true,
    });
    const synced = await fakeBrowser.storage.sync.get("list_sync_settings");
    expect(synced.list_sync_settings).toEqual({
      kinds: {},
      includePrivate: false,
      includeAdult: true,
    });
    expect(await listSyncSettings.getValue()).toMatchObject({
      includeAdult: true,
      ignore: ["mal:1"],
      auto: true,
    });
  });

  it("moves an ignore list an older build synced, and never reads its auto", async () => {
    await fakeBrowser.storage.sync.set({
      list_sync_settings: { ...DEFAULT_SYNC_SETTINGS, ignore: ["anilist:5"], auto: true },
    });
    expect(await listSyncSettings.getValue()).toMatchObject({ ignore: ["anilist:5"], auto: false });
    const local = await fakeBrowser.storage.local.get("list_sync_ignore");
    expect(local.list_sync_ignore).toEqual(["anilist:5"]);
  });

  it("calls a watcher when any part changes", async () => {
    const seen: boolean[] = [];
    const off = listSyncSettings.watch((s) => seen.push(!!s.auto));
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: true });
    await new Promise((r) => setTimeout(r, 0));
    off();
    expect(seen).toContain(true);
  });
});
