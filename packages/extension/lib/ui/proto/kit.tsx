import clsx from "clsx";
import type { ComponentChildren } from "preact";

/**
 * Prototype design kit — presentational only (no browser APIs, no effects), so
 * the gallery can render every state with mock props. Two visual directions:
 *   "clean" — light, neutral, system-native, dense.
 *   "trakt" — dark, branded (Trakt red), roomier, card-based.
 * Pick one and we wire it into the real popup / picker.
 */
export type Variant = "clean" | "trakt";

export interface Tokens {
  page: string;
  panel: string;
  heading: string;
  sub: string;
  faint: string;
  card: string;
  divider: string;
  primary: string;
  ghost: string;
  danger: string;
  link: string;
  input: string;
  chip: string;
  okBox: string;
  badBox: string;
  infoBox: string;
}

export function tokens(v: Variant): Tokens {
  if (v === "trakt") {
    return {
      page: "bg-zinc-950",
      panel: "bg-zinc-900 text-zinc-100 ring-1 ring-white/10",
      heading: "text-zinc-50",
      sub: "text-zinc-400",
      faint: "text-zinc-500",
      card: "bg-white/[0.04] ring-1 ring-white/10",
      divider: "border-white/10",
      primary: "bg-trakt text-white hover:bg-trakt-600 active:bg-trakt-700",
      ghost: "bg-white/5 text-zinc-200 ring-1 ring-white/10 hover:bg-white/10",
      danger: "bg-white/5 text-rose-300 ring-1 ring-white/10 hover:bg-rose-500/10",
      link: "text-trakt hover:text-trakt-600",
      input:
        "bg-white/5 text-zinc-100 ring-1 ring-white/15 focus:ring-trakt placeholder:text-zinc-500",
      chip: "bg-white/5 text-zinc-300 ring-1 ring-white/10",
      okBox: "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20",
      badBox: "bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/20",
      infoBox: "bg-sky-500/10 text-sky-200 ring-1 ring-sky-500/20",
    };
  }
  return {
    page: "bg-zinc-100",
    panel: "bg-white text-zinc-900 ring-1 ring-zinc-200",
    heading: "text-zinc-900",
    sub: "text-zinc-500",
    faint: "text-zinc-400",
    card: "bg-zinc-50 ring-1 ring-zinc-200",
    divider: "border-zinc-200",
    primary: "bg-trakt text-white hover:bg-trakt-600 active:bg-trakt-700",
    ghost: "bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-50",
    danger: "bg-white text-rose-600 ring-1 ring-zinc-300 hover:bg-rose-50",
    link: "text-trakt hover:text-trakt-600",
    input: "bg-white text-zinc-900 ring-1 ring-zinc-300 focus:ring-trakt placeholder:text-zinc-400",
    chip: "bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200",
    okBox: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    badBox: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
    infoBox: "bg-sky-50 text-sky-800 ring-1 ring-sky-200",
  };
}

type IconName =
  | "check"
  | "link"
  | "plus"
  | "settings"
  | "x"
  | "target"
  | "chevron"
  | "external"
  | "play"
  | "copy"
  | "frame";

const PATHS: Record<IconName, string> = {
  check: "M20 6 9 17l-5-5",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  plus: "M12 5v14 M5 12h14",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 6 9.4l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 11 4.6V4.5a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 2.83 1.17l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 11h.1a2 2 0 1 1 0 4h-.1Z",
  x: "M18 6 6 18 M6 6l12 12",
  target: "M22 12h-4 M6 12H2 M12 6V2 M12 22v-4 M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  chevron: "m9 18 6-6-6-6",
  external: "M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  play: "M6 4v16l14-8z",
  copy: "M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2Z M5 15H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1",
  frame: "M3 5h18v14H3z M3 9h18 M9 9v10",
};

export function Icon({
  name,
  class: cls,
  fill,
}: {
  name: IconName;
  class?: string;
  fill?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      class={clsx("size-[1em] shrink-0", cls)}
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

type BtnTone = "primary" | "ghost" | "danger" | "link";

export function Btn({
  tone = "ghost",
  t,
  class: cls,
  children,
  ...rest
}: {
  tone?: BtnTone;
  t: Tokens;
  children: ComponentChildren;
  class?: string;
  disabled?: boolean;
  title?: string;
  onClick?: (e: MouseEvent) => void;
}) {
  const toneCls =
    tone === "primary"
      ? t.primary
      : tone === "danger"
        ? t.danger
        : tone === "link"
          ? `${t.link} underline underline-offset-2`
          : t.ghost;
  return (
    <button
      type="button"
      class={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
        tone === "link" ? "p-0 bg-transparent ring-0" : "px-3 py-1.5",
        toneCls,
        cls,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Section({
  title,
  t,
  children,
  right,
}: {
  title: string;
  t: Tokens;
  children: ComponentChildren;
  right?: ComponentChildren;
}) {
  return (
    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <h2 class={clsx("text-[11px] font-semibold uppercase tracking-wider", t.faint)}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}
