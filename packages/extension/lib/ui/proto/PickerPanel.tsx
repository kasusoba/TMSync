import type { Tracker } from "@/lib/tracker/types";
import clsx from "clsx";
import { Btn, Icon, IconBtn, Switch, type Variant, tokens } from "./kit";

export type FieldKey = "title" | "year" | "season" | "episode";
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
  /** Field label currently being picked, or null. */
  picking?: string | null;
  mediaType: "auto" | "movie" | "show";
  /** Which tracker this recipe routes to (Trakt default; AniList = anime series). */
  tracker: Tracker;
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
  onClear?: (key: FieldKey) => void;
  onClose?: () => void;
  onSave?: () => void;
  onCopy?: () => void;
  onNameChange?: (name: string) => void;
  onMediaTypeChange?: (type: "auto" | "movie" | "show") => void;
  onTrackerChange?: (tracker: Tracker) => void;
  onIframeChange?: (iframe: boolean) => void;
  onManualChange?: (manual: boolean) => void;
  onPickManualKey?: () => void;
  onClearManualKey?: () => void;
}

export function PickerPanel(p: PickerPanelProps) {
  const t = tokens(p.variant);
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
        <div class="absolute inset-x-0 bottom-full mb-2 flex justify-center">
          <span class="inline-flex max-w-full items-center justify-center gap-2 rounded-2xl bg-ikura px-3.5 py-1.5 text-center text-[12px] font-medium leading-snug text-white shadow-lg shadow-black/20">
            <Icon name="target" class="shrink-0 text-[14px]" />
            Click the {p.picking} on the page — or a number in the URL · Esc to cancel
          </span>
        </div>
      )}

      <div class={clsx("w-full rounded-2xl p-3.5 shadow-2xl shadow-black/30", t.panel)}>
        {/* header */}
        <header class="mb-3 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="grid size-6 place-items-center rounded-md bg-ikura text-white">
              <Icon name="target" class="text-[12px]" />
            </span>
            <strong class={clsx("text-[13px]", t.heading)}>
              {p.mode === "edit" ? "Edit site" : "Set up site"}
            </strong>
          </div>
          <IconBtn t={t} name="x" title="Close" onClick={p.onClose} />
        </header>

        {p.banner?.kind === "library" && (
          <div class={clsx("mb-3 rounded-lg px-2.5 py-2 text-[11px] leading-snug", t.infoBox)}>
            A library recipe (“{p.banner.name}”) already covers this page. Saving creates your local
            override — it wins over the library one.
          </div>
        )}

        {p.siteRecipeNote && (
          <div class={clsx("mb-3 rounded-lg px-2.5 py-2 text-[11px] leading-snug", t.infoBox)}>
            You already have a recipe for “{p.siteRecipeNote}” — it applies on its watch pages, not
            this one. (Quick links live in the popup, not here.)
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

        {/* tracker — governs which fields show below, so it sits up top */}
        <div class="mb-3">
          <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Scrobble to</span>
          <div class="flex gap-1">
            {(
              [
                ["trakt", "Trakt"],
                ["anilist", "AniList"],
              ] as const
            ).map(([value, lbl]) => (
              <button
                type="button"
                key={value}
                onClick={() => p.onTrackerChange?.(value)}
                class={clsx(
                  "flex-1 rounded-md py-1.5 text-[12px] font-medium transition-colors",
                  p.tracker === value ? "bg-ikura text-white" : t.ghost,
                )}
              >
                {lbl}
              </button>
            ))}
          </div>
          {p.tracker === "anilist" && (
            <div class={clsx("mt-1.5 rounded-lg px-2.5 py-2 text-[10px] leading-snug", t.infoBox)}>
              For <strong>dedicated anime sites</strong> where the episode number matches the
              AniList entry — pick <strong>title + episode</strong>. If numbering doesn’t line up
              (e.g. a general/TMDB site), TMSync refuses the write rather than corrupt your list.
            </div>
          )}
        </div>

        {/* manual mode — a Trakt-only concept (anime sites always have a title) */}
        {p.tracker !== "anilist" && (
          <button
            type="button"
            onClick={() => p.onManualChange?.(!p.manual)}
            class={clsx(
              "mb-3 flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left",
              t.card,
            )}
          >
            <Switch on={!!p.manual} t={t} />
            <span class="min-w-0 flex-1">
              <span class={clsx("block text-[12px]", t.heading)}>Pick titles manually</span>
              <span class={clsx("block text-[10px]", t.faint)}>
                For players with no title to read (local files, watch parties). You’ll choose each
                title from the badge.
              </span>
            </span>
          </button>
        )}

        {p.manual ? (
          <div class="mb-3 space-y-2">
            <div class={clsx("rounded-lg px-2.5 py-2 text-[11px] leading-snug", t.infoBox)}>
              No fields to scrape. When a video plays here, the badge will ask what you’re watching;
              your choice is remembered per title when possible.
            </div>
            {/* optional remember-by element */}
            <div class={clsx("flex items-center gap-2 rounded-lg px-2.5 py-1.5", t.card)}>
              <span class={clsx("w-20 shrink-0 text-[11px] font-medium", t.faint)}>
                Remember by
              </span>
              <span class="flex min-w-0 flex-1 items-center gap-1.5">
                <span class={clsx("truncate text-[12px]", p.manualKeyValue ? t.heading : t.faint)}>
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
                        class={clsx("rounded px-1 py-0.5 text-[9px] font-medium uppercase", t.chip)}
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

            {/* From page title — pick a segment of the browser tab title, for SPA
                players whose real title is only in document.title (og:title is a
                static site name). Click a part to use it as the Title. */}
            {(p.titleParts?.length ?? 0) > 1 && (
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

            {/* type — N/A for AniList (always an anime series) */}
            <label class={clsx("mb-2 block", p.tracker === "anilist" && "hidden")}>
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
          </>
        )}

        {/* iframe toggle — its own full-width row so it sits clean (both modes) */}
        <button
          type="button"
          onClick={() => p.onIframeChange?.(!p.iframe)}
          class={clsx(
            "mb-3 flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left",
            t.card,
          )}
        >
          <Switch on={p.iframe} t={t} />
          <span class="min-w-0 flex-1">
            <span class={clsx("block text-[12px]", t.heading)}>
              Player loads in a separate frame
            </span>
            <span class={clsx("block text-[10px]", t.faint)}>
              Turn on if the video is inside an iframe from another site.
            </span>
          </span>
        </button>

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

        {/* actions */}
        <div class="flex gap-2">
          <Btn t={t} tone="primary" class="flex-1" disabled={!hasTitle} onClick={p.onSave}>
            {saveLabel}
          </Btn>
          <Btn t={t} tone="ghost" disabled={!hasTitle} onClick={p.onCopy} title="Copy recipe JSON">
            <Icon name="copy" class="text-[13px]" />
            JSON
          </Btn>
        </div>

        {p.status && <p class={clsx("mt-2 text-[11px]", t.sub)}>{p.status}</p>}
      </div>
    </div>
  );
}
