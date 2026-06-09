import "@/lib/ui/theme.css";
import { render } from "preact";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { type QuickLinkItem, QuickLinksView } from "./proto/QuickLinksView";

export type { QuickLinkItem };

/**
 * Inject the quick-links block right after Trakt's own external-links list.
 * `getItems` is called on every (re)mount so the links stay fresh across Trakt's
 * in-page navigations (autoMount re-runs when `ul.external` reappears).
 *
 * Tailwind is injected into the shadow root via `cssInjectionMode: "ui"` on the
 * trakt content script (theme vars resolve through Tailwind's `:root, :host`).
 */
export async function mountQuickLinks(
  ctx: ContentScriptContext,
  getItems: () => QuickLinkItem[],
): Promise<void> {
  const ui = await createShadowRootUi(ctx, {
    name: "tmsync-quicklinks",
    position: "inline",
    anchor: "ul.external",
    append: "after",
    onMount: (container) => render(<QuickLinksView variant="dark" items={getItems()} />, container),
    onRemove: (container) => container && render(null, container),
  });
  ui.autoMount();
}
