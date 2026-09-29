import { listSyncSettings } from "@/lib/storage";
import { DEFAULT_SYNC_SETTINGS } from "@/lib/sync/types";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { applyBackup, buildBackup, parseBackup } from "./backup";

describe("backup: list sync settings", () => {
  beforeEach(() => fakeBrowser.reset());

  it("leaves automatic sync out, and keeps the rest", async () => {
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: true, ignore: ["mal:1"] });
    const built = await buildBackup();
    expect(built.data.listSync).not.toHaveProperty("auto");
    const backup = parseBackup(JSON.parse(JSON.stringify(built)));
    // A second browser, where automatic sync is off: it stays off.
    await listSyncSettings.setValue(DEFAULT_SYNC_SETTINGS);
    await applyBackup(backup as NonNullable<typeof backup>);
    expect(await listSyncSettings.getValue()).toMatchObject({ auto: false, ignore: ["mal:1"] });
  });

  it("keeps this device's automatic sync when an older backup carries it", async () => {
    await listSyncSettings.setValue({ ...DEFAULT_SYNC_SETTINGS, auto: false });
    const raw = JSON.parse(JSON.stringify(await buildBackup()));
    raw.data.listSync.auto = true;
    const backup = parseBackup(JSON.parse(JSON.stringify(raw)));
    await applyBackup(backup as NonNullable<typeof backup>);
    expect((await listSyncSettings.getValue()).auto).toBe(false);
  });
});
