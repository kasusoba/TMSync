import { PickerApp } from "@/lib/picker/PickerApp";
import { keepAboveModals } from "@/lib/ui/top-layer";
import { render } from "preact";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";

/**
 * Element-picker overlay. Injected on demand into the active tab via
 * scripting.executeScript when the user clicks "Set up this site" in the popup
 * (after granting the per-origin permission). Not in the manifest
 * (`registration: "runtime"`), so it never auto-runs.
 *
 * Renders Preact inside a Shadow DOM (style/markup isolated from the host page).
 * Styles are inlined by the component, so no web-accessible CSS is needed.
 */
export default defineContentScript({
  matches: ["*://*/*"],
  registration: "runtime",
  cssInjectionMode: "ui",
  async main(ctx) {
    // Guard against double-injection (user reopens the popup and clicks again).
    if (document.querySelector("tmsync-picker")) return;

    // The site's player often lives in a modal <dialog> (browser top layer) that
    // both buries our overlay under any z-index AND makes it inert (unclickable).
    // Re-parent our host into the active modal so the picker is visible and
    // interactive; the disposer (set on mount) stops the keep-in-modal observer.
    let dropTopLayer = () => {};
    const ui = await createShadowRootUi(ctx, {
      name: "tmsync-picker",
      position: "overlay",
      anchor: "body",
      onMount: (container, _shadow, host) => {
        render(<PickerApp onClose={() => ui.remove()} />, container);
        dropTopLayer = keepAboveModals(host);
      },
      onRemove: (container) => {
        dropTopLayer();
        if (container) render(null, container);
      },
    });
    ui.mount();
  },
});
