import "@/lib/ui/theme.css";
import { render } from "preact";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { type QuickLinkItem, QuickLinksView } from "./kit/QuickLinksView";

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
    /**
     * Whether to use WXT's `autoMount` (default true — waits for `anchor` and
     * re-mounts as it comes and goes). Set `false` for a plain one-shot `mount`
     * instead: WXT's `autoMount` throws ("autoMount and Element anchor option
     * cannot be combined") the instant `anchor` is a function that resolves to
     * an already-existing `Element` (it needs a re-evaluable selector/XPath
     * STRING to poll, not a live element) — so any caller that only calls this
     * once IT has already confirmed the anchor exists (e.g. driving its own
     * mount/unmount off other page-state, like a drawer open/close signal) must
     * pass `auto: false` and manage removal itself via the returned `remove()`.
     */
    auto?: boolean;
  } = {},
) {
  // Captured so `update()` can re-paint with fresh items — an SPA's data can land
  // AFTER the first mount (AniList renders the sidebar title async on nav), so the
  // first paint may have no links and needs re-running once the page fills in.
  let mounted: Element | null = null;
  const paint = () => {
    if (!mounted) return;
    render(
      <QuickLinksView variant="dark" items={getItems()} label={opts.label} class={opts.class} />,
      mounted,
    );
  };

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
      mounted = container;
      paint();
    },
    onRemove: (container) => {
      mounted = null;
      container && render(null, container);
    },
  });
  if (opts.auto === false) ui.mount();
  else ui.autoMount();
  // Returned so SPA hosts (AniList) can remove + re-mount on client-side nav, and
  // re-paint (`update`) as late-loading page data fills the links in.
  return { remove: () => ui.remove(), update: paint };
}
