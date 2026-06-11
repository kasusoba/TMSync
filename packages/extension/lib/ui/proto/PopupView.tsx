import type { FrameNode } from "@/lib/diagnostics/frame-tree";
import type { Tracker } from "@/lib/tracker/types";
import type { LinkTemplates } from "@tmsync/shared";
import clsx from "clsx";
import { FrameInspector } from "./FrameInspector";
import { QuickLinkEditor, type QuickLinkValue } from "./QuickLinkEditor";
import {
  AniListMark,
  Btn,
  Icon,
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
  onOpenOptions?: () => void;
  // --- per-site "watch on this site" quick link (independent of recipes) ---
  /** Hostname of the active tab's top page; null = no eligible page. */
  quickLinkHost?: string | null;
  /** The site's saved quick link, if any (then we're editing). */
  quickLinkInitial?: QuickLinkValue | null;
  /** Best-guess templates from the active tab URL for a tracker. */
  quickLinkDerive?: (tracker: Tracker) => LinkTemplates;
  onSaveQuickLink?: (value: QuickLinkValue) => void;
  onRemoveQuickLink?: () => void;
  // --- frame inspector (diagnostics) — rebuild the page's iframe tree in-extension ---
  /** Whether the inspector is open. */
  inspecting?: boolean;
  /** Flattened frame tree (pre-order); null = open but not yet scanned. */
  frameTree?: FrameNode[] | null;
  onToggleInspect?: () => void;
  onScanFrames?: () => void;
}

/** One provider row (mark + name + status + connect/disconnect). Uniform per provider. */
function ProviderRow({
  t,
  mark,
  name,
  connected,
  busy,
  onConnect,
  onDisconnect,
}: {
  t: Tokens;
  mark: preact.ComponentChildren;
  name: string;
  connected: boolean;
  busy?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
}) {
  return (
    <div class={clsx("flex items-center gap-3 rounded-xl px-3 py-2.5", t.card)}>
      {mark}
      <span class="min-w-0 flex-1">
        <span class={clsx("block text-[13px] font-semibold", t.heading)}>{name}</span>
        <span class={clsx("flex items-center gap-1.5 text-[11px]", t.sub)}>
          {connected && <span class="size-1.5 rounded-full bg-emerald-500" />}
          {connected ? "Connected" : "Not connected"}
        </span>
      </span>
      {connected ? (
        <Btn t={t} tone="ghost" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Btn>
      ) : (
        <Btn t={t} tone="primary" disabled={busy} onClick={onConnect}>
          Connect
        </Btn>
      )}
    </div>
  );
}

function host(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
}

export function PopupView(p: PopupViewProps) {
  const t = tokens(p.variant);
  const origins = p.origins ?? [];
  return (
    <div class={clsx("w-[360px] p-4 antialiased", t.page)}>
      <div class={clsx("rounded-2xl p-4 space-y-5", t.panel)}>
        {/* header */}
        <header class="flex items-center gap-2">
          <span class={clsx("text-[15px] font-semibold tracking-tight", t.heading)}>TMSync</span>
        </header>

        {/* Account — a provider list: Trakt + AniList (independent, never synced). */}
        <Section title="Account" t={t}>
          <div class="space-y-1.5">
            <ProviderRow
              t={t}
              mark={<TraktMark />}
              name="Trakt"
              connected={p.connected}
              busy={p.busy}
              onConnect={p.onConnect}
              onDisconnect={p.onDisconnect}
            />
            <ProviderRow
              t={t}
              mark={<AniListMark />}
              name="AniList"
              connected={p.anilistConnected ?? false}
              busy={p.busy}
              onConnect={p.onConnectAniList}
              onDisconnect={p.onDisconnectAniList}
            />
          </div>
          {!p.connected && p.redirectUri && (
            <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
              Set this redirect URI in your Trakt app:
              <code
                class={clsx(
                  "mt-1 block break-all rounded-md px-2 py-1 font-mono text-[10px]",
                  t.chip,
                )}
              >
                {p.redirectUri}
              </code>
            </p>
          )}
        </Section>

        {/* Sites on this page */}
        <Section
          title="On this page"
          t={t}
          right={
            origins.length > 0 && (
              <Btn t={t} tone="link" onClick={p.onToggleInspect}>
                <Icon name="search" class="text-[12px]" />
                {p.inspecting ? "Hide frames" : "Inspect frames"}
              </Btn>
            )
          }
        >
          {origins.length === 0 ? (
            <p class={clsx("rounded-xl px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
              No streaming page in the active tab.
            </p>
          ) : (
            <div class="space-y-1.5">
              {origins.map((o) => (
                <div
                  key={o.origin}
                  class={clsx("flex items-center justify-between rounded-xl px-3 py-2", t.card)}
                >
                  <span class="flex min-w-0 items-center gap-2">
                    <code
                      class={clsx("truncate font-mono text-[12px]", t.heading)}
                      title={o.origin}
                    >
                      {host(o.origin)}
                    </code>
                    {!o.isTop && (
                      <span
                        class={clsx(
                          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          t.chip,
                        )}
                      >
                        <Icon name="frame" class="text-[10px]" />
                        frame
                      </span>
                    )}
                  </span>
                  {o.enabled ? (
                    <Btn
                      t={t}
                      tone="ghost"
                      disabled={p.busy}
                      onClick={() => p.onDisable?.(o.origin)}
                    >
                      <Icon name="check" class="text-[13px] text-emerald-500" />
                      Enabled
                    </Btn>
                  ) : (
                    <Btn
                      t={t}
                      tone="primary"
                      disabled={p.busy}
                      onClick={() => p.onEnable?.(o.origin)}
                    >
                      Enable
                    </Btn>
                  )}
                </div>
              ))}

              <button
                type="button"
                disabled={p.busy}
                onClick={p.onSetup}
                class={clsx(
                  "group mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition disabled:opacity-50",
                  t.card,
                  "hover:ring-2 hover:ring-ikura",
                )}
              >
                <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-ikura/15 text-ikura">
                  <Icon name="target" class="text-[17px]" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class={clsx("block text-[13px] font-semibold", t.heading)}>
                    Set up this site
                  </span>
                  <span class={clsx("block text-[11px]", t.sub)}>
                    Point &amp; click to teach TMSync this page
                  </span>
                </span>
                <Icon
                  name="chevron"
                  class={clsx(
                    "text-[16px] transition-transform group-hover:translate-x-0.5",
                    t.faint,
                  )}
                />
              </button>
              <p class={clsx("px-1 text-[11px] leading-relaxed", t.faint)}>
                Player in another frame? Press play so it loads, then reopen this popup to enable
                it.
              </p>

              {p.inspecting && (
                <FrameInspector
                  t={t}
                  nodes={p.frameTree ?? null}
                  busy={p.busy}
                  onRescan={p.onScanFrames}
                  onEnable={p.onEnable}
                  onDisable={p.onDisable}
                />
              )}
            </div>
          )}
        </Section>

        {/* Watch-on link — per-SITE, editable from any page (not tied to a recipe) */}
        {p.quickLinkHost && (
          <Section title="Watch-on link" t={t}>
            <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
              A button on {p.quickLinkInitial?.tracker === "anilist" ? "anilist.co" : "Trakt"} pages
              that opens <span class="font-mono">{p.quickLinkHost}</span>. Per-site — works from any
              page here.
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
          </Section>
        )}

        {p.note && <p class={clsx("rounded-lg px-3 py-2 text-[12px]", t.infoBox)}>{p.note}</p>}

        <footer class={clsx("border-t pt-3", t.divider)}>
          <button
            type="button"
            onClick={p.onOpenOptions}
            class={clsx(
              "flex w-full items-center justify-between text-[12px]",
              t.sub,
              "hover:opacity-80",
            )}
          >
            Manage sites, recipes &amp; corrections
            <Icon name="chevron" class="text-[14px]" />
          </button>
        </footer>
      </div>
    </div>
  );
}
