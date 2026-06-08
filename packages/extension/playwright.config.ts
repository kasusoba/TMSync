import { defineConfig } from "@playwright/test";

// E2E loads the BUILT extension (.output/chrome-mv3) in real Chromium. Run
// `pnpm build` first (the `e2e` script does this), then `playwright test`.
export default defineConfig({
  testDir: "./e2e",
  // Extensions need a persistent context; keep runs serial to avoid profile clashes.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    trace: "on-first-retry",
  },
});
