import {
  forkBases,
  listSyncSettings,
  quickLinks,
  recipeSources,
  siteSourcePins,
} from "@/lib/storage";
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

describe("backup: recipe sources", () => {
  beforeEach(() => fakeBrowser.reset());

  it("carries source URLs and picks, and adds only new sources on restore", async () => {
    const a = { id: "a", url: "https://example.org/a.json", enabled: true };
    const b = { id: "b", url: "https://example.org/b.json", enabled: false };
    await recipeSources.setValue([a, b]);
    await siteSourcePins.setValue({ "x.to": "b" });
    const backup = parseBackup(JSON.parse(JSON.stringify(await buildBackup())));
    await recipeSources.setValue([{ ...a, id: "other-id" }]);
    await siteSourcePins.setValue({});
    const summary = await applyBackup(backup as NonNullable<typeof backup>);
    expect(summary.sources).toBe(1);
    expect((await recipeSources.getValue()).map((s) => s.id)).toEqual(["other-id", "b"]);
    expect(await siteSourcePins.getValue()).toEqual({ "x.to": "b" });
  });

  it("moves picks and fork bases onto the id this device uses for the same URL", async () => {
    const a = { id: "a", url: "https://example.org/a.json", enabled: true };
    await recipeSources.setValue([a]);
    await siteSourcePins.setValue({ "x.to": "a" });
    await forkBases.setValue({ r: { sourceId: "a", hash: "h" } });
    const backup = parseBackup(JSON.parse(JSON.stringify(await buildBackup())));
    await recipeSources.setValue([{ ...a, id: "here" }]);
    await siteSourcePins.setValue({});
    await forkBases.setValue({});
    await applyBackup(backup as NonNullable<typeof backup>);
    expect(await siteSourcePins.getValue()).toEqual({ "x.to": "here" });
    expect(await forkBases.getValue()).toEqual({ r: { sourceId: "here", hash: "h" } });
  });

  it("drops only a source with a non-https URL", async () => {
    const backup = parseBackup({
      app: "tmsync",
      version: 1,
      exportedAt: 0,
      data: {
        recipeSources: [
          { id: "a", url: "http://example.org/a.json", enabled: true },
          { id: "b", url: "https://example.org/b.json", enabled: true },
        ],
      },
    });
    const summary = await applyBackup(backup as NonNullable<typeof backup>);
    expect(summary.sources).toBe(1);
    expect((await recipeSources.getValue()).map((x) => x.id)).toEqual(["b"]);
  });

  it("reads an old library link as the user's own", async () => {
    const backup = parseBackup({
      app: "tmsync",
      version: 1,
      exportedAt: 0,
      data: {
        userQuickLinks: [{ id: "l", name: "L", enabled: true, source: "library", host: "x.to" }],
        libraryLinkToggles: { gone: true },
      },
    });
    expect(backup).not.toBeNull();
    await applyBackup(backup as NonNullable<typeof backup>);
    expect(await quickLinks.getValue()).toEqual([
      { id: "l", name: "L", enabled: true, source: "user", host: "x.to" },
    ]);
  });
});
