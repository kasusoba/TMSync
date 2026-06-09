import clsx from "clsx";
import type { ComponentChildren } from "preact";

/**
 * Prototype design kit — presentational only (no browser APIs, no effects), so
 * the gallery can render every state with mock props. Two visual directions:
 *   "light" — light, neutral surfaces.
 *   "dark"  — dark surfaces.
 * Both use the Trakt-red accent. Pick one and we wire it into the real UI.
 */
export type Variant = "light" | "dark";

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
  if (v === "dark") {
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

export type IconName =
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
  | "frame"
  | "search"
  | "trash"
  | "refresh"
  | "up"
  | "down"
  | "edit"
  | "minimize";

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
  search: "m21 21-4.35-4.35 M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  trash:
    "M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5",
  up: "m18 15-6-6-6 6",
  down: "m6 9 6 6 6-6",
  edit: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  minimize: "M4 14h6v6 M10 14l-7 7 M20 10h-6V4 M14 10l7-7",
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

/** Consistent square icon button for row actions (edit / reorder / delete …). */
export function IconBtn({
  name,
  t,
  title,
  danger,
  onClick,
}: {
  name: IconName;
  t: Tokens;
  title: string;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      class={clsx(
        "grid size-7 shrink-0 place-items-center rounded-md transition-colors",
        t.faint,
        danger ? "hover:bg-rose-500/10 hover:text-rose-500" : "hover:bg-white/5",
      )}
    >
      <Icon name={name} class="text-[13px]" />
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

export function Switch({
  on,
  t,
  onClick,
}: {
  on: boolean;
  t: Tokens;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      class={clsx(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors",
        on ? "bg-trakt" : clsx(t.chip, "ring-0"),
      )}
    >
      <span
        class={clsx(
          "absolute size-3.5 rounded-full bg-white shadow transition-all",
          on ? "left-[15px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

/** 1–10 star scale, filled up to `value`. Presentational (no hover state). */
export function Stars({ value }: { value: number | null }) {
  return (
    <span class="inline-flex items-center gap-px">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <span
          key={n}
          class={clsx(
            "text-[16px] leading-none",
            value && n <= value ? "text-amber-400" : "text-zinc-500/40",
          )}
        >
          ★
        </span>
      ))}
      <span class="ml-1.5 text-[11px] opacity-70">{value ? `${value}/10` : "—"}</span>
    </span>
  );
}
