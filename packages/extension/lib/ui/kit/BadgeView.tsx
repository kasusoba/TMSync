import type { Tracker } from "@/lib/tracker/types";
import clsx from "clsx";
import { AniListMark, Btn, Icon, IconBtn, Stars, TraktMark, type Variant, tokens } from "./kit";

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

/**
 * The resting scrobble bar (dot + state + title + minimize + disclosure chevron).
 * The chevron signals the bar opens the actions panel; "Hide" moved into that panel
 * to keep the resting overlay uncluttered. Mirrors the real badge in badge.tsx.
 */
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
        "flex w-[300px] items-center gap-2.5 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
        t.panel,
      )}
    >
      <span class={clsx("size-2.5 shrink-0 rounded-full", s.color)} />
      <span class="min-w-0 flex-1">
        <span class={clsx("block text-[12px] font-semibold", t.heading)}>TMSync · {s.label}</span>
        {title && <span class={clsx("block truncate text-[12px]", t.sub)}>{title}</span>}
      </span>
      <IconBtn t={t} name="minimize" title="Minimize" />
      <IconBtn t={t} name="up" title="Show tracking, rate, or fix the match" />
    </div>
  );
}

/**
 * The "now" actions panel — auto-opens when a watch lands, and what the chevron
 * opens. The per-tracker match (each fixable) + the Rate/note launchpad + the
 * relocated Hide-badge control. Mirrors the "now" panel in badge.tsx.
 */
export function NowPanel({
  variant,
  trackers = ["trakt"],
}: {
  variant: Variant;
  trackers?: Tracker[];
}) {
  const t = tokens(variant);
  return (
    <div class={clsx("w-[300px] rounded-2xl p-3.5 shadow-2xl shadow-black/40", t.panel)}>
      <span class={clsx("mb-1 block text-[11px]", t.faint)}>Tracking</span>
      <div class="space-y-1">
        {trackers.map((tk) => (
          <div key={tk} class={clsx("flex items-center gap-1 rounded-lg pr-1 pl-2.5", t.card)}>
            <span class="flex min-w-0 flex-1 items-center gap-2 py-1.5">
              {tk === "anilist" ? <AniListMark class="size-4" /> : <TraktMark class="size-4" />}
              <span class={clsx("shrink-0 text-[12px] font-medium", t.heading)}>
                {tk === "anilist" ? "AniList" : "Trakt"}
              </span>
              <span class={clsx("ml-1 min-w-0 flex-1 truncate text-[10px]", t.faint)}>
                → The Boondocks
              </span>
            </span>
            <IconBtn t={t} name="edit" title="Fix match" />
          </div>
        ))}
      </div>
      <Btn t={t} tone="primary" class="mt-3 w-full">
        <Icon name="edit" class="text-[12px]" />
        Rate / note
      </Btn>
      <button
        type="button"
        class={clsx(
          "mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-white/5",
          t.faint,
        )}
      >
        <Icon name="eye-off" class="text-[11px]" />
        Hide badge on this page
      </button>
    </div>
  );
}

/** Minimized: a live status dot with a soft glow. Click to expand. */
export function BadgeMini({ state }: { state: BadgeState }) {
  return (
    <button type="button" title="TMSync · click to expand" class="grid place-items-center p-1.5">
      <span class={clsx("size-3.5 rounded-full", STATE[state].color, STATE[state].glow)} />
    </button>
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
  trackers = ["trakt"],
}: {
  variant: Variant;
  isShow: boolean;
  level?: (typeof LEVELS)[number];
  value: number | null;
  note: string;
  hasNote: boolean;
  spoiler: boolean;
  /** Enabled trackers (multi-track): the composer fans out; AniList only on "show". */
  trackers?: Tracker[];
}) {
  const t = tokens(variant);
  const anilistApplies = level === "show";
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
                  level === l ? "bg-ikura text-white" : t.ghost,
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      )}

      {trackers.length > 1 && (
        <div class="mb-3">
          <span class={clsx("mb-1 block text-[11px]", t.faint)}>Send to</span>
          <div class="flex flex-wrap gap-1.5">
            {trackers.map((tk) => {
              const canSend = tk === "trakt" || anilistApplies;
              return (
                <span
                  key={tk}
                  title={canSend ? undefined : "AniList rates the whole entry · pick “show”"}
                  class={clsx(
                    "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 ring-inset",
                    t.card,
                    canSend ? "ring-2 ring-ikura" : "ring-1 ring-transparent opacity-40",
                  )}
                >
                  {tk === "anilist" ? <AniListMark class="size-4" /> : <TraktMark class="size-4" />}
                  <span class={clsx("text-[12px] font-medium", t.heading)}>
                    {tk === "anilist" ? "AniList" : "Trakt"}
                  </span>
                  {canSend && <Icon name="check" class="text-[12px] text-ikura" />}
                </span>
              );
            })}
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
        placeholder="Your note · public on Trakt, at least 5 words…"
        class={clsx(
          "mb-2 w-full resize-none rounded-lg px-2.5 py-2 text-[12px] outline-none ring-inset focus:ring-2",
          t.input,
        )}
      />

      {trackers.includes("trakt") && (
        <label class={clsx("mb-3 flex items-center gap-2 text-[11px]", t.sub)}>
          <input type="checkbox" class="accent-trakt" checked={spoiler} readOnly />
          Mark as spoiler
          <span class={t.faint} title="Only applies to Trakt public comments">
            <Icon name="info" class="text-[12px]" />
          </span>
        </label>
      )}

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

/** Episode prompt bar: a show URL with no episode (e.g. a "?play=true" link). */
export function EpisodePrompt({ variant }: { variant: Variant }) {
  const t = tokens(variant);
  return (
    <div
      class={clsx(
        "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
        t.panel,
      )}
    >
      <span class={clsx("whitespace-nowrap text-[12px] font-semibold", t.heading)}>
        Which episode?
      </span>
      <Btn t={t} tone="primary" class="ml-auto">
        Set episode
      </Btn>
    </div>
  );
}

/** Episode chooser: supply season/episode for a show URL that carries none. */
export function EpisodePickPanel({ variant, title }: { variant: Variant; title?: string }) {
  const t = tokens(variant);
  return (
    <div class={clsx("w-[300px] rounded-2xl p-3.5 shadow-2xl shadow-black/40", t.panel)}>
      <header class="mb-3 flex items-center justify-between">
        <strong class={clsx("text-[13px]", t.heading)}>Which episode?</strong>
        <IconBtn t={t} name="x" title="Close" />
      </header>
      {title && <p class={clsx("mb-2 truncate text-[12px]", t.sub)}>{title}</p>}
      <p class={clsx("mb-3 text-[11px]", t.faint)}>
        This page’s URL doesn’t say which episode is playing. Set it so TMSync can scrobble.
      </p>
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
      <Btn t={t} tone="primary" class="w-full">
        Set episode &amp; scrobble
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
              type === tt ? "bg-ikura text-white" : t.ghost,
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
                "hover:ring-2 hover:ring-ikura",
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
                    "hover:ring-2 hover:ring-ikura",
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
