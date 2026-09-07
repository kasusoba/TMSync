/**
 * Marks the page with the build timestamp of the code that is actually running
 * (`__TMSYNC_BUILD__`, injected by Vite, see wxt.config.ts).
 *
 * An unpacked extension is easy to leave stale: reloading the extensions LIST is
 * not reloading the extension, a second profile can hold its own copy of the same
 * folder, and nothing in the UI says which build injected. Read the stamp in the
 * page console to settle it:
 *
 *   document.documentElement.dataset.tmsyncBuild
 */
export function stampBuild(): void {
  document.documentElement.dataset.tmsyncBuild = __TMSYNC_BUILD__;
}
