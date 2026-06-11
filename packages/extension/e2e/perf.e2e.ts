import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal shapes for the extension APIs we touch inside the service worker (the
// function bodies run in the SW where `chrome` is real; this just keeps tsc happy).
declare const chrome: {
  storage: {
    local: { set(items: Record<string, unknown>): Promise<void> };
    sync: { set(items: Record<string, unknown>): Promise<void> };
  };
  tabs: { query(q: { url: string }): Promise<{ id?: number }[]> };
  scripting: { executeScript(o: unknown): Promise<unknown> };
};

const EXT = path.resolve(here, "../.output/chrome-mv3");
const ORIGIN = "http://localhost:5599";
const URL = `${ORIGIN}/churn.html`;

test("the content script keeps a churning page responsive (no freeze)", async () => {
  const ctx: BrowserContext = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      "--headless=new",
      "--no-sandbox",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker");

    // Seed a recipe that matches the fixture (so a session is published and the
    // session's video-search hot path actually runs) and enable the origin.
    // WXT storage keys drop the `local:` prefix.
    await sw.evaluate(async (origin) => {
      await chrome.storage.local.set({
        custom_recipes: [
          {
            id: "e2e-churn",
            schemaVersion: 2,
            name: "Churn",
            match: { urlPattern: "localhost:5599/churn" },
            mediaType: "movie",
            tracker: "trakt",
            video: { selector: "video", frame: "auto", watchedThreshold: 0.8 },
            extract: { title: { source: "meta", selector: "og:title", transforms: ["trim"] } },
          },
        ],
        enabled_origins: [origin],
      });
      // Seed a saved badge position so the badge's positioning code runs — that's
      // where a re-render loop once froze the tab. (sync storage; key un-prefixed.)
      await chrome.storage.sync.set({
        badge_prefs: { mode: "full", position: { edge: "right", offset: 0.5 } },
      });
    }, ORIGIN);

    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: "domcontentloaded" });

    // Inject the content script (runtime-registered in prod; injected here).
    const tabId = await sw.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: `${u}*` });
      return tab?.id;
    }, URL);
    expect(tabId).toBeTruthy();
    await sw.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id, allFrames: true },
        files: ["content-scripts/content.js"],
      });
    }, tabId);

    // Probe the page's responsiveness repeatedly WHILE it churns. A freeze (a sync
    // loop on the page's main thread, which content scripts share) makes
    // page.evaluate hang — so we race it against a Node timer (in the test process,
    // unaffected by the page freeze). A timed-out probe ⇒ the page was frozen.
    const responsive = (deadlineMs: number): Promise<boolean> =>
      Promise.race([
        page.evaluate(() => 1).then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), deadlineMs)),
      ]);

    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(400);
      expect(await responsive(1500)).toBe(true);
    }

    // And the page's own heartbeat advanced (a frozen thread stalls setInterval).
    const beat0 = await page.evaluate(() => (window as unknown as { __beat: number }).__beat);
    await page.waitForTimeout(500);
    const beat1 = await page.evaluate(() => (window as unknown as { __beat: number }).__beat);
    expect(beat1).toBeGreaterThan(beat0);
  } finally {
    await ctx.close();
  }
});
