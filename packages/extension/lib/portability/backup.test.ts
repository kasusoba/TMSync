import { listSyncSettings } from "@/lib/storage";
import { DEFAULT_SYNC_SETTINGS } from "@/lib/sync/types";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { applyBackup, buildBackup, parseBackup } from "./backup";

describe("backup: list sync settings", () => {
  beforeEach(() => fakeBrowser.reset());

  it("carries automatic sync through a backup", async () => {
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: true, ignore: ["mal:1"] });
    const backup = parseBackup(JSON.parse(JSON.stringify(await buildBackup())));
    await listSyncSettings.setValue(DEFAULT_SYNC_SETTINGS);
    await applyBackup(backup as NonNullable<typeof backup>);
    expect(await listSyncSettings.getValue()).toMatchObject({ auto: true, ignore: ["mal:1"] });
  });

  it("keeps this device's automatic sync for a backup made before it existed", async () => {
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: true });
    const raw = JSON.parse(JSON.stringify(await buildBackup()));
    raw.data.listSync.auto = undefined;
    const backup = parseBackup(JSON.parse(JSON.stringify(raw)));
    await applyBackup(backup as NonNullable<typeof backup>);
    expect((await listSyncSettings.getValue()).auto).toBe(true);
  });
});
