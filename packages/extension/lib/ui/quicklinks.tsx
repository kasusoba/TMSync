import "@/lib/ui/theme.css";
import { render } from "preact";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { type QuickLinkItem, QuickLinksView } from "./proto/QuickLinksView";

export type { QuickLinkItem };

/**
 * Inject the quick-links block next to a tracker page's own external-links list.
 * `getItems` is called on every (re)mount so the links stay fresh across the
 * site's in-page navigations (autoMount re-runs when `anchor` reappears).
 *
 * The anchor differs per tracker: Trakt's external links are `ul.external`;
 * AniList's are `.external-links`. Tailwind is injected into the shadow root via
 * `cssInjectionMode: "ui"` on the content script (theme vars resolve through
 * Tailwind's `:root, :host`).
 */
export async function mountQuickLinks(
  ctx: ContentScriptContext,
  getItems: () => QuickLinkItem[],
  opts: {
    /** CSS selector or a resolver fn (for text-matched anchors like a section). */
    anchor?: string | (() => Element | null | undefined);
    append?: "after" | "before" | "first" | "last";
    /** Header label; null slots the block into an existing section, headerless. */
    label?: string | null;
    /** Extra spacing classes (margins) so the block doesn't touch host elements. */
    class?: string;
  } = {},
) {
  const ui = await createShadowRootUi(ctx, {
    name: "tmsync-quicklinks",
    position: "inline",
    anchor: opts.anchor ?? "ul.external",
    append: opts.append ?? "after",
    onMount: (container, _shadow, host) => {
      // The shadow host is a custom element → display:inline by default, so a
      // fixed-width child spills out of a narrow column (e.g. Trakt's poster
      // sidebar). Make it a full-width block so the links wrap to the column.
      host.style.display = "block";
      host.style.width = "100%";
      render(
        <QuickLinksView variant="dark" items={getItems()} label={opts.label} class={opts.class} />,
        container,
      );
    },
    onRemove: (container) => container && render(null, container),
  });
  ui.autoMount();
  // Returned so SPA hosts (AniList) can remove + re-mount on client-side nav.
  return ui;
}
