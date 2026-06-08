import { expect, test } from "./fixtures";

/**
 * Smoke E2E: the built extension loads in real Chromium, the MV3 service worker
 * boots, and the popup + options pages render. Catches build/manifest/SW-boot
 * regressions that unit tests can't (they run in node, not a browser).
 */
test("service worker boots with a stable extension id", ({ extensionId }) => {
  // Stable id from the committed manifest `key` (Chrome ids are a–p, len 32).
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test("popup renders the Trakt connect state", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole("heading", { name: "TMSync" })).toBeVisible();
  // Not connected in a fresh profile → the Connect action is shown.
  await expect(page.getByRole("button", { name: "Connect Trakt" })).toBeVisible();
});

test("options renders its sections", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.getByRole("heading", { name: "TMSync settings" })).toBeVisible();
  for (const section of ["Trakt", "Enabled sites", "Quick links", "Recipe library"]) {
    await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
  }
});
