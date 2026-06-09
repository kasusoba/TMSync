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
 * The "Watch on …" block injected after Trakt's own external-links list. Wide
 * chip → the deep link (or search if that's all we have); a compact magnifier
 * appears only when both exist, so a site never takes two wide slots.
 */
export function QuickLinksView({ variant, items }: { variant: Variant; items: QuickLinkItem[] }) {
  const t = tokens(variant);
  return (
    <div class="w-[280px] space-y-2">
      <div class={clsx("text-[10px] font-semibold uppercase tracking-wider", t.faint)}>
        Watch on
      </div>
      <div class="flex flex-wrap gap-1.5">
        {items.map((i) => {
          const primary = i.direct ?? i.search;
          if (!primary) return null;
          return (
            <div class="inline-flex items-stretch gap-px" key={i.name}>
              <a
                href={primary}
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
