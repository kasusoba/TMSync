import clsx from "clsx";
import { Btn, Icon, Stars, Switch, type Variant, tokens } from "./kit";

export type BadgeState = "idle" | "watching" | "paused" | "scrobbled" | "stopped" | "error";

const STATE: Record<BadgeState, { color: string; label: string }> = {
  idle: { color: "bg-zinc-400", label: "matched" },
  watching: { color: "bg-emerald-500", label: "scrobbling" },
  paused: { color: "bg-amber-500", label: "paused" },
  scrobbled: { color: "bg-sky-500", label: "added to history" },
  stopped: { color: "bg-zinc-500", label: "stopped" },
  error: { color: "bg-rose-500", label: "error" },
};

/** The resting scrobble pill (dot + state + title + minimize). */
export function BadgePill({
  variant,
  state,
  title,
}: {
  variant: Variant;
  state: BadgeState;
  title?: string;
}) {
  const t = tokens(variant);
  const s = STATE[state];
  return (
    <div
      class={clsx(
        "relative inline-flex max-w-[340px] items-center gap-2.5 rounded-xl py-2 pr-7 pl-3 shadow-xl shadow-black/30",
        t.panel,
      )}
    >
      <span class={clsx("size-2.5 shrink-0 rounded-full", s.color)} />
      <span class="min-w-0">
        <span class={clsx("block text-[12px] font-semibold", t.heading)}>TMSync · {s.label}</span>
        {title && <span class={clsx("block truncate text-[12px]", t.sub)}>{title}</span>}
      </span>
      <button
        type="button"
        class={clsx(
          "absolute top-1 right-1.5 grid size-5 place-items-center rounded-md text-[15px] leading-none",
          t.faint,
          "hover:bg-white/5",
        )}
        title="Minimize to a dot"
      >
        −
      </button>
    </div>
  );
}

/** Minimized: just a live status dot. */
export function BadgeMini({ variant, state }: { variant: Variant; state: BadgeState }) {
  return (
    <span
      class={clsx(
        "inline-block size-4 rounded-full shadow-lg shadow-black/40 ring-2",
        STATE[state].color,
        variant === "dark" ? "ring-white/80" : "ring-white",
      )}
    />
  );
}

/** Compact rating prompt shown right after a watch lands in history. */
export function RatingPrompt({
  variant,
  label,
  value,
}: {
  variant: Variant;
  label: string;
  value: number | null;
}) {
  const t = tokens(variant);
  return (
    <div
      class={clsx(
        "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
        t.panel,
      )}
    >
      <span class={clsx("whitespace-nowrap text-[12px] font-semibold", t.heading)}>{label}</span>
      <Stars value={value} />
      <button
        type="button"
        class={clsx(
          "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
          t.ghost,
        )}
      >
        <Icon name="edit" class="text-[11px]" />
        Note
      </button>
      <button
        type="button"
        class={clsx("grid size-6 place-items-center rounded-md", t.faint, "hover:bg-white/5")}
        title="Dismiss"
      >
        <Icon name="x" class="text-[12px]" />
      </button>
    </div>
  );
}

const LEVELS = ["episode", "season", "show"] as const;

/** Full rate + note panel. */
export function RateNotePanel({
  variant,
  isShow,
  level = "episode",
  value,
  note,
  hasNote,
  spoiler,
}: {
  variant: Variant;
  isShow: boolean;
  level?: (typeof LEVELS)[number];
  value: number | null;
  note: string;
  hasNote: boolean;
  spoiler: boolean;
}) {
  const t = tokens(variant);
  return (
    <div class={clsx("w-[300px] rounded-2xl p-3.5 shadow-2xl shadow-black/40", t.panel)}>
      <header class="mb-3 flex items-center justify-between">
        <strong class={clsx("text-[13px]", t.heading)}>Rate &amp; note</strong>
        <button type="button" class={clsx("grid size-7 place-items-center rounded-md", t.faint)}>
          <Icon name="x" class="text-[14px]" />
        </button>
      </header>

      {isShow && (
        <div class="mb-3">
          <span class={clsx("mb-1 block text-[11px]", t.faint)}>Rate &amp; note the</span>
          <div class="flex gap-1">
            {LEVELS.map((l) => (
              <button
                key={l}
                type="button"
                class={clsx(
                  "flex-1 rounded-md py-1 text-[11px] capitalize transition-colors",
                  level === l ? "bg-trakt text-white" : t.ghost,
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="mb-3">
        <span class={clsx("mb-1 block text-[11px]", t.faint)}>Your rating</span>
        <Stars value={value} />
      </div>

      <textarea
        rows={4}
        value={note}
        placeholder="Your note — public on Trakt, at least 5 words…"
        class={clsx(
          "mb-2 w-full resize-none rounded-lg px-2.5 py-2 text-[12px] outline-none ring-inset focus:ring-2",
          t.input,
        )}
      />

      <div class={clsx("mb-3 flex items-center gap-2 text-[11px]", t.sub)}>
        <Switch on={spoiler} t={t} />
        Mark as spoiler
      </div>

      <div class="flex items-stretch gap-2">
        <Btn t={t} tone="primary" class="flex-1">
          {hasNote ? "Update note" : "Post note"}
        </Btn>
        {hasNote && (
          <Btn t={t} tone="danger" title="Delete note">
            <Icon name="trash" class="text-[13px]" />
          </Btn>
        )}
        <Btn t={t} tone="link" class="ml-auto">
          Wrong match?
        </Btn>
      </div>
    </div>
  );
}

/** Fix-match (correction) panel. */
export function CorrectionPanel({
  variant,
  query,
  results,
  saved,
}: {
  variant: Variant;
  query: string;
  results: string[];
  saved?: string | null;
}) {
  const t = tokens(variant);
  return (
    <div class={clsx("w-[300px] rounded-2xl p-3.5 shadow-2xl shadow-black/40", t.panel)}>
      <header class="mb-3 flex items-center justify-between">
        <strong class={clsx("text-[13px]", t.heading)}>Fix match</strong>
        <button type="button" class={clsx("grid size-7 place-items-center rounded-md", t.faint)}>
          <Icon name="x" class="text-[14px]" />
        </button>
      </header>
      {saved ? (
        <p class={clsx("rounded-lg px-2.5 py-2 text-[12px]", t.okBox)}>
          Corrected → {saved}. It’ll re-scrobble now.
        </p>
      ) : (
        <>
          <div class="mb-3 flex gap-2">
            <div class={clsx("flex flex-1 items-center gap-2 rounded-lg px-2.5", t.input)}>
              <Icon name="search" class={clsx("text-[14px]", t.faint)} />
              <input
                value={query}
                placeholder="Search Trakt…"
                class="w-full bg-transparent py-1.5 text-[13px] outline-none"
              />
            </div>
            <Btn t={t} tone="primary">
              Search
            </Btn>
          </div>
          <div class="flex flex-col gap-1.5">
            {results.length === 0 ? (
              <p class={clsx("py-1 text-[12px]", t.faint)}>Search and pick the right title.</p>
            ) : (
              results.map((r) => (
                <button
                  key={r}
                  type="button"
                  class={clsx(
                    "truncate rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors",
                    t.card,
                    t.heading,
                    "hover:ring-2 hover:ring-trakt",
                  )}
                >
                  {r}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
