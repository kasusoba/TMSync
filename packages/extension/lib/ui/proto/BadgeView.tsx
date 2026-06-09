import clsx from "clsx";
import { Btn, Icon, IconBtn, Stars, Switch, type Variant, tokens } from "./kit";

export type BadgeState = "idle" | "watching" | "paused" | "scrobbled" | "stopped" | "error";

// `glow` is a soft outer glow in the state colour (used by the minimized dot).
const STATE: Record<BadgeState, { color: string; glow: string; label: string }> = {
  idle: {
    color: "bg-zinc-400",
    glow: "shadow-[0_0_7px_2px_rgba(161,161,170,0.4)]",
    label: "matched",
  },
  watching: {
    color: "bg-emerald-500",
    glow: "shadow-[0_0_8px_2px_rgba(16,185,129,0.55)]",
    label: "scrobbling",
  },
  paused: {
    color: "bg-amber-500",
    glow: "shadow-[0_0_8px_2px_rgba(245,158,11,0.55)]",
    label: "paused",
  },
  scrobbled: {
    color: "bg-sky-500",
    glow: "shadow-[0_0_8px_2px_rgba(56,189,248,0.55)]",
    label: "added to history",
  },
  stopped: {
    color: "bg-zinc-500",
    glow: "shadow-[0_0_7px_2px_rgba(113,113,122,0.4)]",
    label: "stopped",
  },
  error: {
    color: "bg-rose-500",
    glow: "shadow-[0_0_8px_2px_rgba(244,63,94,0.55)]",
    label: "error",
  },
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
        "inline-flex max-w-[340px] items-center gap-2.5 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
        t.panel,
      )}
    >
      <span class={clsx("size-2.5 shrink-0 rounded-full", s.color)} />
      <span class="min-w-0 flex-1">
        <span class={clsx("block text-[12px] font-semibold", t.heading)}>TMSync · {s.label}</span>
        {title && <span class={clsx("block truncate text-[12px]", t.sub)}>{title}</span>}
      </span>
      <IconBtn t={t} name="minimize" title="Minimize" />
    </div>
  );
}

/** Minimized: a live status dot with a soft glow. Click to expand. */
export function BadgeMini({ state }: { state: BadgeState }) {
  return (
    <button type="button" title="TMSync — click to expand" class="grid place-items-center p-1.5">
      <span class={clsx("size-3.5 rounded-full", STATE[state].color, STATE[state].glow)} />
    </button>
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
      <IconBtn t={t} name="x" title="Dismiss" />
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
        <IconBtn t={t} name="x" title="Close" />
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
        <button
          type="button"
          class={clsx("ml-auto text-[12px] underline underline-offset-2", t.sub)}
        >
          Wrong match?
        </button>
      </div>
    </div>
  );
}

/** Manual-mode prompt bar: shown when a manual site has no pick yet. */
export function ManualPrompt({ variant }: { variant: Variant }) {
  const t = tokens(variant);
  return (
    <div
      class={clsx(
        "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
        t.panel,
      )}
    >
      <span class={clsx("whitespace-nowrap text-[12px] font-semibold", t.heading)}>
        What are you watching?
      </span>
      <Btn t={t} tone="primary" class="ml-auto">
        Pick title
      </Btn>
    </div>
  );
}

/** Manual-mode picker: choose what's playing on a site with no readable title. */
export function ManualPickPanel({
  variant,
  type = "movie",
  query,
  results,
}: {
  variant: Variant;
  type?: "movie" | "show";
  query: string;
  results: string[];
}) {
  const t = tokens(variant);
  return (
    <div class={clsx("w-[300px] rounded-2xl p-3.5 shadow-2xl shadow-black/40", t.panel)}>
      <header class="mb-3 flex items-center justify-between">
        <strong class={clsx("text-[13px]", t.heading)}>What are you watching?</strong>
        <IconBtn t={t} name="x" title="Close" />
      </header>

      <div class="mb-3 flex gap-1">
        {(["movie", "show"] as const).map((tt) => (
          <button
            key={tt}
            type="button"
            class={clsx(
              "flex-1 rounded-md py-1 text-[11px] capitalize transition-colors",
              type === tt ? "bg-trakt text-white" : t.ghost,
            )}
          >
            {tt}
          </button>
        ))}
      </div>

      {type === "show" && (
        <div class="mb-3 flex gap-2">
          {["Season", "Episode"].map((l) => (
            <label key={l} class="flex-1">
              <span class={clsx("mb-1 block text-[11px]", t.faint)}>{l}</span>
              <input
                placeholder="1"
                class={clsx(
                  "w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none ring-inset focus:ring-2",
                  t.input,
                )}
              />
            </label>
          ))}
        </div>
      )}

      <div class="mb-3 flex gap-2">
        <div class={clsx("flex flex-1 items-center gap-2 rounded-lg px-2.5", t.input)}>
          <Icon name="search" class={clsx("text-[14px]", t.faint)} />
          <input
            value={query}
            placeholder={`Search ${type}s on Trakt…`}
            class="w-full bg-transparent py-1.5 text-[13px] outline-none"
          />
        </div>
        <Btn t={t} tone="primary">
          Search
        </Btn>
      </div>

      <div class="flex flex-col gap-1.5">
        {results.length === 0 ? (
          <p class={clsx("py-1 text-[12px]", t.faint)}>
            Search and pick the title you’re watching.
          </p>
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
        <IconBtn t={t} name="x" title="Close" />
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
