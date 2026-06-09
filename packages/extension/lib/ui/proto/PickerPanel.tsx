import clsx from "clsx";
import { Btn, Icon, IconBtn, Switch, type Variant, tokens } from "./kit";

export type FieldKey = "title" | "year" | "season" | "episode";
export interface FieldRow {
  key: FieldKey;
  label: string;
  value: string | null;
  source?: "url" | "meta" | "jsonld" | "dom" | "title";
}
export type UrlPart = { text: string } | { num: string; ordinal: number };

export interface PickerPanelProps {
  variant: Variant;
  mode: "setup" | "edit";
  name: string;
  fields: FieldRow[];
  urlParts: UrlPart[];
  /** Field label currently being picked, or null. */
  picking?: string | null;
  mediaType: "auto" | "movie" | "show";
  iframe: boolean;
  preview: { ok: true; text: string } | { ok: false; error: string };
  banner?: { kind: "library"; name: string } | null;
  status?: string | null;
  /** Override the save/copy enabled state (default: title currently resolves). */
  canSave?: boolean;
  /** Manual mode: no scraping — the user picks each title from the badge. */
  manual?: boolean;
  /** Manual only: the current "remember-by" element value, if one is picked. */
  manualKeyValue?: string | null;
  onPick?: (key: FieldKey) => void;
  onPickToken?: (ordinal: number) => void;
  onClear?: (key: FieldKey) => void;
  onClose?: () => void;
  onSave?: () => void;
  onCopy?: () => void;
  onNameChange?: (name: string) => void;
  onMediaTypeChange?: (type: "auto" | "movie" | "show") => void;
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
    <div class="space-y-2">
      {p.picking && (
        <div class="flex justify-center">
          <span class="inline-flex items-center gap-2 rounded-full bg-trakt px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg shadow-black/20">
            <Icon name="target" class="text-[14px]" />
            Click the {p.picking} on the page — or a number in the URL · Esc to cancel
          </span>
        </div>
      )}

      <div class={clsx("w-[320px] rounded-2xl p-3.5 shadow-2xl shadow-black/30", t.panel)}>
        {/* header */}
        <header class="mb-3 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="grid size-6 place-items-center rounded-md bg-trakt text-white">
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

        {/* manual-mode toggle */}
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
                  p.picking === "remember-by element" ? "bg-trakt text-white" : t.ghost,
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
                    <span class={clsx("truncate text-[12px]", f.value ? t.heading : t.faint)}>
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
                      p.picking === f.label ? "bg-trakt text-white" : t.ghost,
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
                      onClick={() => p.onPickToken?.(part.ordinal)}
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

            {/* type */}
            <label class="mb-2 block">
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
