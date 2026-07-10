import type { FrameNode } from "@/lib/diagnostics/frame-tree";
import type { Tracker } from "@/lib/tracker/types";
import type { LinkTemplates } from "@tmsync/shared";
import clsx from "clsx";
import { useState } from "preact/hooks";
import { FrameInspector } from "./FrameInspector";
import { QuickLinkEditor, type QuickLinkValue } from "./QuickLinkEditor";
import {
  AniListMark,
  Btn,
  Icon,
  IconBtn,
  Section,
  type Tokens,
  TraktMark,
  type Variant,
  tokens,
} from "./kit";

export interface OriginRow {
  origin: string;
  isTop: boolean;
  enabled: boolean;
}

export interface PopupViewProps {
  variant: Variant;
  connected: boolean;
  redirectUri?: string;
  /** AniList account (the second provider — independent of Trakt). */
  anilistConnected?: boolean;
  /** null = no eligible page in the active tab. */
  origins: OriginRow[] | null;
  busy?: boolean;
  note?: string | null;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onConnectAniList?: () => void;
  onDisconnectAniList?: () => void;
  onEnable?: (origin: string) => void;
  onDisable?: (origin: string) => void;
  onSetup?: () => void;
  /** A custom recipe already covers this page → the picker opens in edit mode. */
  pageHasRecipe?: boolean;
  onOpenOptions?: () => void;
  // --- per-site quick link (independent of recipes) ---
  /** Hostname of the active tab's top page; null = no eligible page. */
  quickLinkHost?: string | null;
  /** The site's saved quick link, if any (then we're editing). */
  quickLinkInitial?: QuickLinkValue | null;
  /** Best-guess templates from the active tab URL for a tracker. */
  quickLinkDerive?: (tracker: Tracker) => LinkTemplates;
  onSaveQuickLink?: (value: QuickLinkValue) => void;
  onRemoveQuickLink?: () => void;
  // --- frame map (diagnostics) — rebuild the page's iframe tree in-extension ---
  // Shown inline (always expanded) whenever the page has embedded frames, mapped
  // automatically on open. No toggle, no rescan.
  /** Flattened frame tree (pre-order); null = not yet scanned / single frame. */
  frameTree?: FrameNode[] | null;
  /** Author a recipe inside a (cross-origin) player frame — injects the picker there. */
  onSetupFrame?: (origin: string, frameId: number) => void;
  /** "Now scrobbling" surface (status + prompts) for the active tab, when one exists. */
  nowPlaying?: preact.ComponentChildren;
  // --- on-page badge visibility (quick toggle; full control still in Options) ---
  /** Current on-page badge mode. Omit to hide the control. */
  badgeMode?: BadgeMode;
  onBadgeMode?: (mode: BadgeMode) => void;
}

export type BadgeMode = "full" | "dot" | "off";

/**
 * The on-page badge visibility control — one line, icon-only (a pill = full panel,
 * a dot = status dot, an eye-off = hidden). Shared by the popup and the Options
 * Display setting so the two stay identical.
 */
export function BadgeModeToggle({
  t,
  mode,
  onMode,
}: {
  t: Tokens;
  mode: BadgeMode;
  onMode?: (mode: BadgeMode) => void;
}) {
  const items: [BadgeMode, string][] = [
    ["full", "Full badge"],
    ["dot", "Dot only"],
    ["off", "Hidden"],
  ];
  return (
    <div class="flex gap-1">
      {items.map(([value, label]) => (
        <button
          type="button"
          key={value}
          title={label}
          aria-label={label}
          onClick={() => onMode?.(value)}
          class={clsx(
            "grid size-7 place-items-center rounded-md transition-colors",
            mode === value ? "bg-ikura text-white" : t.ghost,
          )}
        >
          {value === "full" ? (
            <span class="h-2.5 w-4 rounded-sm bg-current" />
          ) : value === "dot" ? (
            <span class="size-2 rounded-full bg-current" />
          ) : (
            <Icon name="eye-off" class="text-[13px]" />
          )}
        </button>
      ))}
    </div>
  );
}

function SubLabel({ t, children }: { t: Tokens; children: preact.ComponentChildren }) {
  return (
    <span class={clsx("block px-1 text-[10px] font-semibold uppercase tracking-wide", t.faint)}>
      {children}
    </span>
  );
}

export function PopupView(p: PopupViewProps) {
  const t = tokens(p.variant);
  const origins = p.origins ?? [];
  const topRow = origins.find((o) => o.isTop) ?? origins[0] ?? null;
  // The unified video-detection list: the scanned frame tree (top + indented child
  // frames) if present, else a single top-node fallback built from the top origin —
  // so the row shows instantly (before the scan lands) and in the gallery.
  const frameNodes: FrameNode[] =
    p.frameTree && p.frameTree.length > 0
      ? p.frameTree
      : topRow
        ? [
            {
              frameId: 0,
              url: topRow.origin,
              origin: topRow.origin,
              isTop: true,
              reached: false,
              enabled: topRow.enabled,
              title: "",
              videos: [],
              hasVideo: false,
              hasActiveVideo: false,
              children: [],
              depth: 0,
            },
          ]
        : [];
  const noAccount = !p.connected && !(p.anilistConnected ?? false);
  const [watchOpen, setWatchOpen] = useState(false);

  return (
    <div class={clsx("w-[360px] space-y-4 p-4 antialiased", t.page)}>
      {/* header */}
      <header class="flex items-center justify-between">
        <span class={clsx("text-[15px] font-semibold tracking-tight", t.heading)}>TMSync</span>
        <IconBtn t={t} name="settings" title="Options" onClick={p.onOpenOptions} />
      </header>

      {/* No-tracker prompt — accounts are managed in Options; the popup only nudges
          you to connect when nothing is linked yet. */}
      {noAccount && (
        <div class={clsx("space-y-2 rounded-xl px-3 py-2.5", t.infoBox)}>
          <p class="text-[12px] leading-snug">Connect a tracker to start scrobbling.</p>
          <div class="flex gap-2">
            <Btn t={t} tone="primary" class="flex-1" disabled={p.busy} onClick={p.onConnect}>
              <TraktMark class="size-4" /> Connect Trakt
            </Btn>
            <Btn t={t} tone="ghost" class="flex-1" disabled={p.busy} onClick={p.onConnectAniList}>
              <AniListMark class="size-4" /> AniList
            </Btn>
          </div>
        </div>
      )}

      {/* Now scrobbling — status + any pending prompt for the active tab. */}
      {p.nowPlaying}

      {/* This page — video DETECTION (access + frames) and the RECIPE (picker),
          kept visibly separate so it's clear the two are different things. */}
      <Section title="This page" t={t}>
        {!topRow ? (
          <p class={clsx("rounded-xl px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
            No streaming page in the active tab.
          </p>
        ) : (
          <div class="space-y-3">
            <div class="space-y-1.5">
              <SubLabel t={t}>Video detection</SubLabel>
              {/* One list: the top site is the first row, embedded player frames are
                  indented children (mapped automatically on open, no toggle). */}
              <FrameInspector
                t={t}
                nodes={frameNodes}
                busy={p.busy}
                onEnable={p.onEnable}
                onDisable={p.onDisable}
                onSetupFrame={p.onSetupFrame}
              />
            </div>

            <div class="space-y-1.5">
              <SubLabel t={t}>Recipe</SubLabel>
              <Btn t={t} tone="primary" class="w-full" disabled={p.busy} onClick={p.onSetup}>
                <Icon name={p.pageHasRecipe ? "edit" : "target"} class="text-[13px]" />
                {p.pageHasRecipe ? "Edit recipe" : "Set up recipe"}
              </Btn>
              <p class={clsx("px-1 text-[10px] leading-relaxed", t.faint)}>
                {p.pageHasRecipe
                  ? "A recipe already covers this page · tweak how it reads what’s playing."
                  : "Point & click to teach TMSync what’s playing here."}
              </p>
            </div>
          </div>
        )}
      </Section>

      {/* On-page badge — between this-page and quick links. One line, icon toggle. */}
      {p.badgeMode && (
        <div class="flex items-center justify-between">
          <span class={clsx("text-[11px] font-semibold uppercase tracking-wider", t.faint)}>
            On-page badge
          </span>
          <BadgeModeToggle t={t} mode={p.badgeMode} onMode={p.onBadgeMode} />
        </div>
      )}

      {/* Quick links — per-SITE, editable from any page (not tied to a recipe). */}
      {p.quickLinkHost && (
        <Section
          title="Quick links"
          t={t}
          right={
            <Btn t={t} tone="ghost" onClick={() => setWatchOpen((v) => !v)}>
              {watchOpen ? (
                "Hide"
              ) : (
                <>
                  <Icon name={p.quickLinkInitial ? "edit" : "plus"} class="text-[12px]" />
                  {p.quickLinkInitial ? "Edit" : "Add"}
                </>
              )}
            </Btn>
          }
        >
          {watchOpen ? (
            <>
              <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
                A quick link on {p.quickLinkInitial?.tracker === "anilist" ? "anilist.co" : "Trakt"}{" "}
                pages that opens <span class="font-mono">{p.quickLinkHost}</span>. Per-site · works
                from any page here.
              </p>
              <QuickLinkEditor
                key={p.quickLinkHost}
                t={t}
                host={p.quickLinkHost}
                initial={p.quickLinkInitial}
                derive={p.quickLinkDerive}
                busy={p.busy}
                onSave={(v) => p.onSaveQuickLink?.(v)}
                onRemove={p.quickLinkInitial ? () => p.onRemoveQuickLink?.() : undefined}
              />
            </>
          ) : (
            <p class={clsx("text-[11px] leading-relaxed", t.faint)}>
              {p.quickLinkInitial
                ? `Quick link added · opens ${p.quickLinkHost} from ${p.quickLinkInitial.tracker === "anilist" ? "anilist.co" : "Trakt"}.`
                : `Add a quick link on Trakt/AniList pages that opens ${p.quickLinkHost}.`}
            </p>
          )}
        </Section>
      )}

      {p.note && <p class={clsx("rounded-lg px-3 py-2 text-[12px]", t.infoBox)}>{p.note}</p>}
    </div>
  );
}
