import { defineConfig } from "@playwright/test";

/**
 * Perf E2E: loads the built extension into Chromium and asserts it doesn't freeze
 * a churning page (the regression that froze cineby/popcornmovies). Separate from
 * the Vitest unit tests (which are `*.test.ts`); these are `*.e2e.ts`.
 *
 * Run with: pnpm test:e2e  (builds with E2E=1, then runs this).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  webServer: {
    command: "python3 -m http.server 5599 --directory e2e/fixtures",
    port: 5599,
    reuseExistingServer: true,
  },
});
