import clsx from "clsx";
import { Icon, type Variant, tokens } from "./kit";

export interface QuickLinkItem {
  name: string;
  /** id-based deep link, when one could be built. */
  direct?: string;
  /** title/slug search link, when the recipe defines one. */
  search?: string;
}

/**
 * The "Watch on …" block injected next to a tracker page's own provider list.
 * Wide chip → the deep link (or search if that's all we have); a compact
 * magnifier appears only when both exist, so a site never takes two wide slots.
 * `label` is the small header; pass null to omit it (e.g. when slotting the
 * block INTO an existing section so it reads as part of it).
 */
export function QuickLinksView({
  variant,
  items,
  loading = false,
  label = "Watch on",
  class: cls,
}: {
  variant: Variant;
  items: QuickLinkItem[];
  /**
   * The host page hasn't produced the media details yet, so the links can't be
   * built. Shows placeholder chips instead of a half-built list: on a tracker's
   * client-side navigation the id is known from the URL long before the title is
   * on the page, so painting `items` right away shows the id-only links and then
   * rearranges the block a beat later.
   */
  loading?: boolean;
  label?: string | null;
  /** Extra spacing/layout classes for the host page (e.g. margins so it doesn't
   * touch the page's own elements). */
  class?: string;
}) {
  const t = tokens(variant);
  return (
    <div class={clsx("w-full max-w-[280px] space-y-2", cls)}>
      {label && (
        <div class={clsx("text-[10px] font-semibold uppercase tracking-wider", t.faint)}>
          {label}
        </div>
      )}
      <div class="flex flex-wrap gap-1.5">
        {loading &&
          // Widths vary so it reads as "sites are coming", not as one grey bar.
          ["w-20", "w-16", "w-24"].map((w) => (
            <div key={w} class={clsx("h-[30px] animate-pulse rounded-lg", w, t.card)} />
          ))}
        {!loading &&
          items.map((i) => {
            const primary = i.direct ?? i.search;
            if (!primary) return null;
            return (
              <div class="inline-flex items-stretch gap-px" key={i.name}>
                <a
                  href={primary}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={clsx(
                    "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                    t.ghost,
                    i.direct && i.search ? "rounded-r-none" : "",
                  )}
                >
                  {i.name}
                  {!i.direct && <Icon name="search" class={clsx("text-[12px]", t.faint)} />}
                </a>
                {i.direct && i.search && (
                  <a
                    href={i.search}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Search ${i.name}`}
                    class={clsx(
                      "grid w-8 place-items-center rounded-lg rounded-l-none transition-colors",
                      t.ghost,
                    )}
                  >
                    <Icon name="search" class="text-[13px]" />
                  </a>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
