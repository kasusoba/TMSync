import type { Tracker } from "@/lib/tracker/types";
import clsx from "clsx";
import {
  AniListMark,
  Btn,
  Icon,
  IconBtn,
  Switch,
  type Tokens,
  TraktMark,
  type Variant,
  tokens,
} from "./kit";

export type FieldKey = "title" | "tmdbId" | "year" | "season" | "episode";
export interface FieldRow {
  key: FieldKey;
  label: string;
  value: string | null;
  source?: "url" | "meta" | "jsonld" | "dom" | "title";
}
export type UrlPart = { text: string } | { num: string; ordinal: number; paramKey?: string };

export interface PickerPanelProps {
  variant: Variant;
  mode: "setup" | "edit";
  name: string;
  fields: FieldRow[];
  urlParts: UrlPart[];
  /** Segments of the page <title> (for "use the Nth part of the tab title"). */
  titleParts?: string[];
  /** A picked DOM element holds several numbers → ask which is the season/episode
   * (e.g. "1x6 – Episode 6": season=1, episode=6). null when not awaiting a pick. */
  domPick?: { field: "season" | "episode"; text: string; parts: UrlPart[] } | null;
  /** Cross-origin player-iframe URLs whose numbers can be picked for a field —
   * for embeds that carry the season/episode in their src (e.g. 1embed.cc). */
  playerFrames?: { src: string; parts: UrlPart[] }[];
  /** Field label currently being picked, or null. */
  picking?: string | null;
  mediaType: "auto" | "movie" | "show";
  /** MULTI-TRACK: the set of enabled trackers (independent per-tracker toggles). */
  trackers: Tracker[];
  iframe: boolean;
  preview: { ok: true; text: string } | { ok: false; error: string };
  banner?: { kind: "library"; name: string } | null;
  /** Name of a recipe that exists for this site but doesn't cover the current URL. */
  siteRecipeNote?: string | null;
  status?: string | null;
  /** Override the save/copy enabled state (default: title currently resolves). */
  canSave?: boolean;
  /** Manual mode: no scraping — the user picks each title from the badge. */
  manual?: boolean;
  /** Manual only: the current "remember-by" element value, if one is picked. */
  manualKeyValue?: string | null;
  onPick?: (key: FieldKey) => void;
  onPickToken?: (ordinal: number, paramKey?: string) => void;
  /** Pick the Nth segment of the page <title> as the title field. */
  onPickTitleSegment?: (index: number) => void;
  /** Pick the Nth number of the just-picked DOM element (season/episode). */
  onPickDomNumber?: (ordinal: number) => void;
  /** Pick the Nth number of a player iframe's src (frame index, number ordinal). */
  onPickFrameToken?: (frameIndex: number, ordinal: number) => void;
  onClear?: (key: FieldKey) => void;
  onClose?: () => void;
  onSave?: () => void;
  onCopy?: () => void;
  onNameChange?: (name: string) => void;
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
    key: "anilist",
    label: "AniList",
    mark: <AniListMark class="size-4" />,
    need: (v) => !!v("title"),
    needHint: "Needs a title.",
  },
];

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

export function PickerPanel(p: PickerPanelProps) {
  const t = tokens(p.variant);
  const fieldVal: FieldVal = (key) => p.fields.find((f) => f.key === key)?.value;
  const saveLabel =
    p.mode === "edit"
      ? "Update recipe"
      : p.banner?.kind === "library"
        ? "Save override & enable"
        : "Save & enable";
  const hasTitle =
    p.canSave ?? (p.manual || p.fields.some((f) => f.key === "title" && f.value !== null));

  return (
    // Fixed-width, position-relative shell: the picker is anchored to the right
    // edge of the screen, so the "click to pick" pill MUST float (absolute) above
    // the panel — letting it grow the shell would swing the left edge out and
    // shove the panel sideways every time you press Pick.
    <div class="relative w-[320px]">
      {p.picking && (
        // Pinned to the top-center of the VIEWPORT (not the panel) so it stays
        // visible while picking even when the panel is tall.
        <div class="fixed inset-x-0 top-4 z-10 flex justify-center px-4">
          <span class="inline-flex max-w-md items-center justify-center gap-2 rounded-2xl bg-ikura px-3.5 py-1.5 text-center text-[12px] font-medium leading-snug text-white shadow-lg shadow-black/20">
            <Icon name="target" class="shrink-0 text-[14px]" />
            Click the {p.picking} on the page — or a number in the URL · Esc to cancel
          </span>
        </div>
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
          {p.banner?.kind === "library" && (
            <div class={clsx("mb-3 rounded-lg px-2.5 py-2 text-[11px] leading-snug", t.infoBox)}>
              A library recipe (“{p.banner.name}”) already covers this page. Saving creates your
              local override — it wins over the library one.
            </div>
          )}

          {p.siteRecipeNote && (
            <div class={clsx("mb-3 rounded-lg px-2.5 py-2 text-[11px] leading-snug", t.infoBox)}>
              You already have a recipe for “{p.siteRecipeNote}” — it applies on its watch pages,
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

          {/* trackers — independent per-tracker toggles, gated on the fields each
            needs (the "master picker": one field set feeds every tracker). More
            trackers can be added to this list without touching the rest. */}
          <div class="mb-3">
            <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Scrobble to</span>
            <div class="flex flex-wrap gap-1.5">
              {TRACKER_TOGGLES.map(({ key, label, mark, need, needHint }) => {
                const canEnable = need(fieldVal);
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
            {p.trackers.includes("anilist") && (
              <p class={clsx("mt-1 text-[10px] leading-snug", t.faint)}>
                AniList tracks anime only — on a general site it’s mapped via the crosswalk
                (non-anime skipped, ambiguous numbering refused).
              </p>
            )}
          </div>

          {/* type — right under the trackers. Hidden in manual mode (nothing scraped)
            and when AniList is the only tracker (always an anime series). */}
          {!p.manual && !(p.trackers.length === 1 && p.trackers[0] === "anilist") && (
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
                  <option value="auto">Auto</option>
                  <option value="movie">Movie</option>
                  <option value="show">Show</option>
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

          {/* manual mode — a no-title concept; irrelevant once AniList is on (anime
            always has a title). Shown only when AniList isn't enabled. */}
          {!p.trackers.includes("anilist") && (
            <ToggleRow
              t={t}
              on={!!p.manual}
              label="Pick titles manually"
              info="For players with no title to read (local files, watch parties). You’ll choose each title from the badge."
              onToggle={() => p.onManualChange?.(!p.manual)}
            />
          )}

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
                        {f.value ?? "—"}
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
                    From the picked element → click the number for{" "}
                    <span class="capitalize">{p.domPick.field}</span>
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

              {/* URL tokens */}
              <div class="mb-3">
                <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>
                  From URL{p.picking ? ` → click a number for ${p.picking}` : ""}
                </span>
                <div
                  class={clsx(
                    "rounded-lg px-2 py-1.5 font-mono text-[11px] leading-7 break-all",
                    t.card,
                    t.sub,
                  )}
                >
                  {p.urlParts.map((part, i) =>
                    "num" in part ? (
                      <button
                        // biome-ignore lint/suspicious/noArrayIndexKey: positional URL tokens are stable
                        key={i}
                        type="button"
                        disabled={!p.picking}
                        title={part.paramKey ? `${part.paramKey}=${part.num}` : undefined}
                        onClick={() => p.onPickToken?.(part.ordinal, part.paramKey)}
                        class={clsx(
                          "mx-0.5 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                          p.picking
                            ? "bg-amber-400/20 text-amber-600 ring-1 ring-amber-400/40 hover:bg-amber-400/40 dark:text-amber-300"
                            : t.chip,
                        )}
                      >
                        {part.num}
                      </button>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: positional URL tokens are stable
                      <span key={i}>{part.text}</span>
                    ),
                  )}
                </div>
              </div>

              {/* From player frame URL — a cross-origin embed (e.g. 1embed.cc) whose
                src carries the season/episode the top page hides. Shown only while
                picking season/episode, since it's a number source. */}
              {(p.picking === "Season" || p.picking === "Episode") &&
                (p.playerFrames?.length ?? 0) > 0 && (
                  <div class="mb-3">
                    <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>
                      From player frame URL → click a number for {p.picking}
                    </span>
                    <div class="space-y-1.5">
                      {p.playerFrames?.map((frame, fi) => (
                        <div
                          // biome-ignore lint/suspicious/noArrayIndexKey: positional frame list is stable
                          key={fi}
                          class={clsx(
                            "rounded-lg px-2 py-1.5 font-mono text-[11px] leading-7 break-all",
                            t.card,
                            t.sub,
                          )}
                        >
                          {frame.parts.map((part, i) =>
                            "num" in part ? (
                              <button
                                // biome-ignore lint/suspicious/noArrayIndexKey: positional tokens are stable
                                key={i}
                                type="button"
                                onClick={() => p.onPickFrameToken?.(fi, part.ordinal)}
                                class="mx-0.5 rounded bg-amber-400/20 px-1.5 py-0.5 text-[11px] text-amber-600 ring-1 ring-amber-400/40 transition-colors hover:bg-amber-400/40 dark:text-amber-300"
                              >
                                {part.num}
                              </button>
                            ) : (
                              // biome-ignore lint/suspicious/noArrayIndexKey: positional tokens are stable
                              <span key={i}>{part.text}</span>
                            ),
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* From page title — pick a segment of the browser tab title, for SPA
                players whose real title is only in document.title (og:title is a
                static site name). Only while picking the Title, since segments
                only feed that field (shown elsewhere it just reads as noise). */}
              {p.picking === "Title" && (p.titleParts?.length ?? 0) > 1 && (
                <div class="mb-3">
                  <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>
                    From page title → click the part that is the title
                  </span>
                  <div class="flex flex-wrap gap-1">
                    {p.titleParts?.map((seg, i) => (
                      <button
                        // biome-ignore lint/suspicious/noArrayIndexKey: positional title segments are stable
                        key={i}
                        type="button"
                        onClick={() => p.onPickTitleSegment?.(i)}
                        class={clsx(
                          "max-w-full truncate rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-ikura hover:text-white",
                          t.chip,
                        )}
                      >
                        {seg}
                      </button>
                    ))}
                  </div>
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
          <Btn t={t} tone="ghost" disabled={!hasTitle} onClick={p.onCopy} title="Copy recipe JSON">
            <Icon name="copy" class="text-[13px]" />
            JSON
          </Btn>
        </div>

        {p.status && <p class={clsx("mt-2 shrink-0 text-[11px]", t.sub)}>{p.status}</p>}
      </div>
    </div>
  );
}
