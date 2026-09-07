import { configDefaults, defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: "happy-dom",
    // Fixture pages carry <iframe> tags (the picker reads a player embed's src).
    // Without this, happy-dom tries to actually FETCH them.
    environmentOptions: { happyDOM: { settings: { disableIframePageLoading: true } } },
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
