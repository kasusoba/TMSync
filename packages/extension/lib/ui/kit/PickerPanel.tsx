import type { NumberPart } from "@/lib/picker/recipe-builder";
import type { Chip, PickSource } from "@/lib/picker/sources";
import { type Tracker, isSeasonless, trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  AniListMark,
  Btn,
  Icon,
  IconBtn,
  MalMark,
  SimklMark,
  Switch,
  type Tokens,
  TraktMark,
  type Variant,
  WetrakrMark,
  tokens,
} from "./kit";

export type FieldKey = "title" | "tmdbId" | "year" | "season" | "episode";
export interface FieldRow {
  key: FieldKey;
  label: string;
  value: string | null;
  source?: "url" | "meta" | "jsonld" | "dom" | "title";
}

export interface PickerPanelProps {
  variant: Variant;
  mode: "setup" | "edit";
  name: string;
  /** The recipe's URL-match regex (editable — lets you split e.g. `…/tmdb-tv-` from
   * `…/tmdb-movie-` into disjoint recipes on a site that encodes type deep in the path). */
  urlPattern?: string;
  /** Whether the current urlPattern actually matches the page (a live footgun check). */
  patternMatchesPage?: boolean;
  fields: FieldRow[];
  /**
   * THE SOURCE PALETTE: every place this page exposes a value for the field being
   * picked: the URL, the page <title>, a player iframe's src, a meta tag, a
   * JSON-LD path. Uniform by design: the same sources are offered for every field,
   * and each chip carries a finished Field, so the panel stays presentational.
   * Supplied only while picking; empty otherwise.
   */
  sources?: PickSource[];
  /** A picked page element holds several numbers → ask which one is this field
   * (e.g. "1x6 – Episode 6": season=1, episode=6). null when not awaiting a pick. */
  domPick?: { label: string; text: string; parts: NumberPart[] } | null;
  /** Field label currently being picked, or null. */
  picking?: string | null;
  mediaType: "auto" | "movie" | "show";
  /** MULTI-TRACK: the set of enabled trackers (independent per-tracker toggles). */
  trackers: Tracker[];
  iframe: boolean;
  preview: { ok: true; text: string } | { ok: false; error: string };
  /** A recipe from the user's recipe source `source` already covers this page. */
  banner?: { kind: "source"; name: string; source: string } | null;
  /** Name of a recipe that exists for this site but doesn't cover the current URL. */
  siteRecipeNote?: string | null;
  status?: string | null;
  /** Override the save enabled state (default: title currently resolves). */
  canSave?: boolean;
  /** No tracker is connected, so a recipe would have nowhere to record: the panel
   * asks the user to connect one instead of showing the setup. */
  noTracker?: boolean;
  /** Open the options page (Account), from the `noTracker` prompt. */
  onOpenSettings?: () => void;
  /** Manual mode: no scraping — the user picks each title from the badge. */
  manual?: boolean;
  /** Manual only: the current "remember-by" element value, if one is picked. */
  manualKeyValue?: string | null;
  onPick?: (key: FieldKey) => void;
  /** Commit the palette chip with this id to the field being picked. */
  onPickChip?: (chipId: string) => void;
  /** Pick the Nth number of the just-picked page element. */
  onPickDomNumber?: (ordinal: number) => void;
  onClear?: (key: FieldKey) => void;
  onClose?: () => void;
  onSave?: () => void;
  onNameChange?: (name: string) => void;
  onUrlPatternChange?: (pattern: string) => void;
  onMediaTypeChange?: (type: "auto" | "movie" | "show") => void;
  /** Toggle a tracker on/off in the enabled set. */
  onTrackerToggle?: (tracker: Tracker) => void;
  onIframeChange?: (iframe: boolean) => void;
  onManualChange?: (manual: boolean) => void;
  onPickManualKey?: () => void;
  onClearManualKey?: () => void;
}

type FieldVal = (key: FieldKey) => string | null | undefined;

/** The per-tracker toggle rows + the fields each needs to be enableable. Add a
 * tracker here (label, description, field requirement) to surface it in the picker
 * — the rest of the panel is tracker-agnostic. */
const TRACKER_TOGGLES: {
  key: Tracker;
  label: string;
  mark: preact.ComponentChildren;
  need: (v: FieldVal) => boolean;
  needHint: string;
}[] = [
  {
    key: "trakt",
    label: "Trakt",
    mark: <TraktMark class="size-4" />,
    need: (v) => !!v("title") || !!v("tmdbId"),
    needHint: "Needs a title or a TMDB id.",
  },
  {
    key: "wetrakr",
    label: "WeTrakr",
    mark: <WetrakrMark class="size-4" />,
    need: (v) => !!v("title") || !!v("tmdbId"),
    needHint: "Needs a title or a TMDB id.",
  },
  {
    key: "anilist",
    label: "AniList",
    mark: <AniListMark class="size-4" />,
    need: (v) => !!v("title"),
    needHint: "Needs a title.",
  },
  {
    key: "mal",
    label: "MyAnimeList",
    mark: <MalMark class="size-4" />,
    need: (v) => !!v("title"),
    needHint: "Needs a title.",
  },
  {
    key: "simkl",
    label: "Simkl",
    mark: <SimklMark class="size-4" />,
    // Simkl matches movies, TV, and anime from a title or any id.
    need: (v) => !!v("title") || !!v("tmdbId"),
    needHint: "Needs a title or a TMDB id.",
  },
];

/** The note under the tracker toggles when a cour tracker is on. */
function courOnlyNote(cour: Tracker[]): string {
  const names = cour.map(trackerLabel).join(" and ");
  const verb = cour.length === 1 ? "tracks" : "track";
  return `${names} ${verb} anime only · on a general site the crosswalk maps it (non-anime skipped, ambiguous numbering refused).`;
}

/** A compact on/off row: switch + label + a hover-info icon (native tooltip) —
 * keeps the picker uncramped instead of a paragraph under every toggle. */
function ToggleRow({
  t,
  on,
  label,
  info,
  onToggle,
}: {
  t: Tokens;
  on: boolean;
  label: string;
  info: string;
  onToggle?: () => void;
}) {
  return (
    <div class={clsx("mb-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2", t.card)}>
      <button type="button" onClick={onToggle} class="flex flex-1 items-center gap-2.5 text-left">
        <Switch on={on} t={t} />
        <span class={clsx("text-[12px]", t.heading)}>{label}</span>
      </button>
      <span class={t.faint} title={info}>
        <Icon name="info" class="text-[13px]" />
      </span>
    </div>
  );
}

/** One piece of a source's value: inert filler, or a clickable value chip. */
function ChipView({
  chip,
  t,
  onPick,
}: {
  chip: Chip;
  t: Tokens;
  onPick?: (chipId: string) => void;
}) {
  if (chip.kind === "lit") return <span>{chip.text}</span>;
  return (
    <button
      type="button"
      title={chip.title}
      onClick={() => onPick?.(chip.id)}
      class="mx-0.5 rounded bg-amber-400/20 px-1.5 py-0.5 text-[11px] text-amber-600 ring-1 ring-amber-400/40 transition-colors hover:bg-amber-400/40 dark:text-amber-300"
    >
      {chip.text}
    </button>
  );
}

/** How close (px) the cursor may come to the hint before it moves out of the way. */
const HINT_DODGE_PX = 48;

/**
 * The "click to pick" hint, pinned to the center of the VIEWPORT (not the panel)
 * so it stays visible while picking even when the panel is tall. It takes no
 * pointer events, so clicks pass through it, but it still hides what is under it
 * (a site's top bar is a common target). So when the cursor comes near it, it
 * moves to the other edge of the screen (top or bottom), and it stays there until
 * the cursor comes near it again.
 */
function PickHint({ children }: { children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const near =
        e.clientX > r.left - HINT_DODGE_PX &&
        e.clientX < r.right + HINT_DODGE_PX &&
        e.clientY > r.top - HINT_DODGE_PX &&
        e.clientY < r.bottom + HINT_DODGE_PX;
      // Go to the half of the screen away from the cursor. Set, not toggled, so a
      // second move before the re-render can't send it back under the cursor.
      if (near) setAtBottom(e.clientY < window.innerHeight / 2);
    };
    window.addEventListener("mousemove", onMove, true);
    return () => window.removeEventListener("mousemove", onMove, true);
  }, []);
  return (
    // Exactly as wide as its text and no pointer events: a full-width band here
    // sat over the whole top of the page and ate every click to the left and
    // right of the hint, including the elements the user is asked to pick.
    <div
      ref={ref}
      class={clsx(
        "pointer-events-none fixed left-1/2 z-10 w-max max-w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2",
        atBottom ? "bottom-4" : "top-4",
      )}
    >
      <span class="inline-flex items-center justify-center gap-2 rounded-2xl bg-ikura px-3.5 py-1.5 text-center text-[12px] font-medium leading-snug text-white shadow-lg shadow-black/20">
        {children}
      </span>
    </div>
  );
}

export function PickerPanel(p: PickerPanelProps) {
  const t = tokens(p.variant);
  const fieldVal: FieldVal = (key) => p.fields.find((f) => f.key === key)?.value;
  const saveLabel =
    p.mode === "edit"
      ? "Update recipe"
      : p.banner?.kind === "source"
        ? "Save override & enable"
        : "Save & enable";
  const hasTitle =
    p.canSave ?? (p.manual || p.fields.some((f) => f.key === "title" && f.value !== null));

  if (p.noTracker) {
    return (
      <div class={clsx("w-[320px] rounded-2xl p-3.5 shadow-2xl shadow-black/30", t.panel)}>
        <header class="mb-3 flex items-center justify-between">
          <strong class={clsx("text-[13px]", t.heading)}>Set up site</strong>
          <IconBtn t={t} name="x" title="Close" onClick={p.onClose} />
        </header>
        <p class={clsx("text-[12px] leading-snug", t.sub)}>
          Connect a tracker first. A site setup records what you watch to your tracker accounts, and
          none is connected yet.
        </p>
        <Btn t={t} tone="primary" class="mt-3 w-full" onClick={p.onOpenSettings}>
          Connect a tracker
        </Btn>
      </div>
    );
  }

  return (
    // Fixed-width, position-relative shell: the picker is anchored to the right
    // edge of the screen, so the "click to pick" pill MUST float (absolute) above
    // the panel — letting it grow the shell would swing the left edge out and
    // shove the panel sideways every time you press Pick.
    <div class="relative w-[320px]">
      {p.picking && (
        <PickHint>
          <Icon name="target" class="shrink-0 text-[14px]" />
          Click the {p.picking} on the page · or choose a value in the panel · Esc to cancel
        </PickHint>
      )}

      <div
        class={clsx(
          "flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-2xl p-3.5 shadow-2xl shadow-black/30",
          t.panel,
        )}
      >
        {/* header — always visible */}
        <header class="mb-3 flex shrink-0 items-center justify-between">
          <strong class={clsx("text-[13px]", t.heading)}>
            {p.mode === "edit" ? "Edit site" : "Set up site"}
          </strong>
          <IconBtn t={t} name="x" title="Close" onClick={p.onClose} />
        </header>

        {/* scrollable body — everything between the pinned header and actions */}
        <div class="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
          {p.banner?.kind === "source" && (
            <div class={clsx("mb-3 rounded-lg px-2.5 py-2 text-[11px] leading-snug", t.infoBox)}>
              A recipe from {p.banner.source} (“{p.banner.name}”) already covers this page. Saving
              creates your local override · it wins over the source one.
            </div>
          )}

          {p.siteRecipeNote && (
            <div class={clsx("mb-3 rounded-lg px-2.5 py-2 text-[11px] leading-snug", t.infoBox)}>
              You already have a recipe for “{p.siteRecipeNote}” · it applies on its watch pages,
              not this one. (Quick links live in the popup, not here.)
            </div>
          )}

          {/* site name */}
          <label class="mb-3 block">
            <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Site name</span>
            <input
              value={p.name}
              onInput={(e) => p.onNameChange?.((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
              class={clsx(
                "w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none ring-inset focus:ring-2",
                t.input,
              )}
            />
          </label>

          {/* URL pattern — which pages this recipe fires on. Editable so a site that
              encodes the media type deep in the path (…/tmdb-tv- vs …/tmdb-movie-)
              can be split into two disjoint recipes instead of one clobbering the other. */}
          {p.urlPattern !== undefined && (
            <label class="mb-3 block">
              <span class={clsx("mb-1 flex items-center justify-between text-[11px]", t.faint)}>
                <span class="font-medium">URL pattern</span>
                <span
                  class={p.patternMatchesPage ? "text-emerald-400" : "text-rose-400"}
                  title="Whether this regex matches the current page URL"
                >
                  {p.patternMatchesPage ? "matches this page" : "no match here"}
                </span>
              </span>
              <input
                value={p.urlPattern}
                spellcheck={false}
                onInput={(e) => p.onUrlPatternChange?.((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.stopPropagation()}
                onKeyUp={(e) => e.stopPropagation()}
                class={clsx(
                  "w-full rounded-lg px-2.5 py-1.5 font-mono text-[11px] outline-none ring-inset focus:ring-2",
                  t.input,
                )}
              />
              <span class={clsx("mt-1 block text-[10px] leading-snug", t.faint)}>
                Regex tested against the page URL. The domain is kept separately, so this keeps
                working if the site moves.
              </span>
            </label>
          )}

          {/* trackers — independent per-tracker toggles, gated on the fields each
            needs (the "master picker": one field set feeds every tracker). More
            trackers can be added to this list without touching the rest. */}
          <div class="mb-3">
            <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Scrobble to</span>
            <div class="flex flex-wrap gap-1.5">
              {TRACKER_TOGGLES.map(({ key, label, mark, need, needHint }) => {
                // In manual mode the user's pick supplies the title and ids.
                const canEnable = !!p.manual || need(fieldVal);
                const on = p.trackers.includes(key);
                const disabled = !canEnable && !on;
                return (
                  <button
                    type="button"
                    key={key}
                    disabled={disabled}
                    title={disabled ? needHint : label}
                    onClick={() => !disabled && p.onTrackerToggle?.(key)}
                    class={clsx(
                      "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 ring-inset transition",
                      t.card,
                      on ? "ring-2 ring-ikura" : "ring-1 ring-transparent",
                      disabled && "opacity-40",
                    )}
                  >
                    {mark}
                    <span class={clsx("text-[12px] font-medium", t.heading)}>{label}</span>
                    {on && <Icon name="check" class="text-[12px] text-ikura" />}
                  </button>
                );
              })}
            </div>
            {p.trackers.length === 0 && (
              <p class={clsx("mt-1 text-[10px]", t.faint)}>Enable at least one tracker.</p>
            )}
            {p.trackers.some(isSeasonless) && (
              <p class={clsx("mt-1 text-[10px] leading-snug", t.faint)}>
                {courOnlyNote(p.trackers.filter(isSeasonless))}
              </p>
            )}
          </div>

          {/* type — right under the trackers. Hidden in manual mode (nothing scraped)
            and when only cour trackers are on (always an anime series). */}
          {!p.manual && !(p.trackers.length > 0 && p.trackers.every(isSeasonless)) && (
            <label class="mb-3 block">
              <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Type</span>
              <div class="relative">
                <select
                  value={p.mediaType}
                  onChange={(e) =>
                    p.onMediaTypeChange?.(
                      (e.target as HTMLSelectElement).value as "auto" | "movie" | "show",
                    )
                  }
                  class={clsx(
                    "w-full appearance-none rounded-lg py-1.5 pr-8 pl-2.5 text-[13px] outline-none ring-inset focus:ring-2",
                    t.input,
                  )}
                >
                  {(
                    [
                      ["auto", "Auto"],
                      ["movie", "Movie"],
                      ["show", "Show"],
                    ] as const
                  ).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <Icon
                  name="down"
                  class={clsx(
                    "pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[14px]",
                    t.faint,
                  )}
                />
              </div>
            </label>
          )}

          {/* manual mode: for a player with no title to read. The pick is searched
            on any connected tracker that can search, so it works with every one. */}
          <ToggleRow
            t={t}
            on={!!p.manual}
            label="Pick titles manually"
            info="For players with no title to read (local files, watch parties). You’ll choose each title from the badge."
            onToggle={() => p.onManualChange?.(!p.manual)}
          />

          {/* player-in-a-separate-frame */}
          <ToggleRow
            t={t}
            on={p.iframe}
            label="Player loads in a separate frame"
            info="Turn on if the video is inside an iframe from another site."
            onToggle={() => p.onIframeChange?.(!p.iframe)}
          />

          {p.manual ? (
            <div class="mb-3 space-y-2">
              <div class={clsx("rounded-lg px-2.5 py-2 text-[11px] leading-snug", t.infoBox)}>
                No fields to scrape. When a video plays here, the badge will ask what you’re
                watching; your choice is remembered per title when possible.
              </div>
              {/* optional remember-by element */}
              <div class={clsx("flex items-center gap-2 rounded-lg px-2.5 py-1.5", t.card)}>
                <span class={clsx("w-20 shrink-0 text-[11px] font-medium", t.faint)}>
                  Remember by
                </span>
                <span class="flex min-w-0 flex-1 items-center gap-1.5">
                  <span
                    class={clsx("truncate text-[12px]", p.manualKeyValue ? t.heading : t.faint)}
                  >
                    {p.manualKeyValue ?? "page title (default)"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => p.onPickManualKey?.()}
                  class={clsx(
                    "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                    p.picking === "remember-by element" ? "bg-ikura text-white" : t.ghost,
                  )}
                >
                  Pick
                </button>
                {p.manualKeyValue && (
                  <button
                    type="button"
                    onClick={() => p.onClearManualKey?.()}
                    class={clsx("grid size-6 place-items-center rounded-md", t.ghost)}
                    title="Clear"
                  >
                    <Icon name="x" class="text-[12px]" />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* fields */}
              <div class="mb-3 space-y-1.5">
                {p.fields.map((f) => (
                  <div
                    key={f.key}
                    class={clsx("flex items-center gap-2 rounded-lg px-2.5 py-1.5", t.card)}
                  >
                    <span class={clsx("w-14 shrink-0 text-[11px] font-medium", t.faint)}>
                      {f.label}
                    </span>
                    <span class="flex min-w-0 flex-1 items-center gap-1.5">
                      <span
                        class={clsx("truncate text-[12px]", f.value ? t.heading : t.faint)}
                        title={f.value ?? undefined}
                      >
                        {f.value ?? "·"}
                      </span>
                      {f.source && (
                        <span
                          class={clsx(
                            "rounded px-1 py-0.5 text-[9px] font-medium uppercase",
                            t.chip,
                          )}
                        >
                          {f.source}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => p.onPick?.(f.key)}
                      class={clsx(
                        "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                        p.picking === f.label ? "bg-ikura text-white" : t.ghost,
                      )}
                    >
                      Pick
                    </button>
                    {f.value && (
                      <button
                        type="button"
                        onClick={() => p.onClear?.(f.key)}
                        class={clsx("grid size-6 place-items-center rounded-md", t.ghost)}
                        title="Clear"
                      >
                        <Icon name="x" class="text-[12px]" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Which number? — the picked element packs several (e.g. "1x6 –
                Episode 6"), so the user clicks the one that is the season/episode. */}
              {p.domPick && (
                <div class="mb-3">
                  <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>
                    From the picked element → click the number for {p.domPick.label}
                  </span>
                  <div
                    class={clsx(
                      "rounded-lg px-2 py-1.5 font-mono text-[11px] leading-7 break-words",
                      t.card,
                      t.sub,
                    )}
                  >
                    {p.domPick.parts.map((part, i) =>
                      "num" in part ? (
                        <button
                          // biome-ignore lint/suspicious/noArrayIndexKey: positional number tokens are stable
                          key={i}
                          type="button"
                          onClick={() => p.onPickDomNumber?.(part.ordinal)}
                          class="mx-0.5 rounded bg-amber-400/20 px-1.5 py-0.5 text-[11px] text-amber-600 ring-1 ring-amber-400/40 transition-colors hover:bg-amber-400/40 dark:text-amber-300"
                        >
                          {part.num}
                        </button>
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: positional number tokens are stable
                        <span key={i}>{part.text}</span>
                      ),
                    )}
                  </div>
                </div>
              )}

              {/* THE SOURCE PALETTE: every place this page exposes a value for
                the field being picked, offered uniformly. It used to be three
                special cases (URL numbers for any field, page-title segments for
                the Title alone, player-frame numbers for Season/Episode alone);
                the engine never had that restriction, so neither does the picker.
                Shown only while picking, since that is when it can be acted on. */}
              {p.picking && (p.sources?.length ?? 0) > 0 && (
                <div class="mb-3 space-y-2.5">
                  <span class={clsx("block text-[11px] font-medium", t.faint)}>
                    Or take {p.picking} from
                  </span>
                  {p.sources?.map((source) => (
                    <div key={source.id}>
                      <span
                        class={clsx(
                          "mb-1 block text-[10px] font-medium uppercase tracking-wide",
                          t.faint,
                        )}
                      >
                        {source.label}
                      </span>
                      <div
                        class={clsx(
                          "space-y-1",
                          // A metadata-heavy page can list dozens of tags; cap the
                          // group's height so one source can't push the rest off-panel.
                          source.entries.length > 5 && "max-h-44 overflow-y-auto",
                        )}
                      >
                        {source.entries.map((entry, ei) => (
                          <div key={entry.key ?? ei} class={clsx("rounded-lg px-2 py-1.5", t.card)}>
                            {entry.key && (
                              <span
                                class={clsx("mb-0.5 block truncate font-mono text-[10px]", t.faint)}
                                title={entry.key}
                              >
                                {entry.key}
                              </span>
                            )}
                            <div class={clsx("font-mono text-[11px] leading-7 break-all", t.sub)}>
                              {entry.chips.map((chip, ci) => (
                                <ChipView
                                  // biome-ignore lint/suspicious/noArrayIndexKey: positional chips are stable
                                  key={ci}
                                  chip={chip}
                                  t={t}
                                  onPick={p.onPickChip}
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* preview */}
          <div
            class={clsx(
              "mb-3 flex items-center gap-1.5 truncate rounded-lg px-2.5 py-2 text-[12px] font-medium",
              p.preview.ok ? t.okBox : t.badBox,
            )}
          >
            <Icon name={p.preview.ok ? "check" : "x"} class="text-[13px]" />
            <span class="truncate">{p.preview.ok ? p.preview.text : p.preview.error}</span>
          </div>
        </div>
        {/* /scrollable body */}

        {/* actions — always visible */}
        <div class={clsx("mt-3 flex shrink-0 gap-2 border-t pt-3", t.divider)}>
          <Btn t={t} tone="primary" class="flex-1" disabled={!hasTitle} onClick={p.onSave}>
            {saveLabel}
          </Btn>
        </div>

        {p.status && <p class={clsx("mt-2 shrink-0 text-[11px]", t.sub)}>{p.status}</p>}
      </div>
    </div>
  );
}
