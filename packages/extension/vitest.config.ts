import { configDefaults, defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: "happy-dom",
    // Playwright E2E specs live in e2e/ — driven by Playwright, not Vitest.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
