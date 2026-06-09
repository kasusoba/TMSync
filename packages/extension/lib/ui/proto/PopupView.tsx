import clsx from "clsx";
import { Btn, Icon, Section, type Variant, tokens } from "./kit";

export interface OriginRow {
  origin: string;
  isTop: boolean;
  enabled: boolean;
}

export interface PopupViewProps {
  variant: Variant;
  connected: boolean;
  redirectUri?: string;
  /** null = no eligible page in the active tab. */
  origins: OriginRow[] | null;
  busy?: boolean;
  note?: string | null;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onEnable?: (origin: string) => void;
  onDisable?: (origin: string) => void;
  onSetup?: () => void;
  onOpenOptions?: () => void;
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
        <header class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="grid size-7 place-items-center rounded-lg bg-trakt text-white">
              <Icon name="play" fill class="text-[13px]" />
            </span>
            <span class={clsx("text-[15px] font-semibold tracking-tight", t.heading)}>TMSync</span>
          </div>
          <Btn t={t} tone="ghost" class="size-8 !px-0" onClick={p.onOpenOptions} title="Settings">
            <Icon name="settings" class="text-[15px]" />
          </Btn>
        </header>

        {/* Trakt connection */}
        <Section title="Trakt" t={t}>
          <div class={clsx("flex items-center justify-between rounded-xl px-3 py-2.5", t.card)}>
            <span class="flex items-center gap-2 text-[13px]">
              <span
                class={clsx(
                  "size-2 rounded-full",
                  p.connected ? "bg-emerald-500" : clsx("ring-1", t.faint, "bg-current opacity-40"),
                )}
              />
              <span class={p.connected ? t.heading : t.sub}>
                {p.connected ? "Connected" : "Not connected"}
              </span>
            </span>
            {p.connected ? (
              <Btn t={t} tone="ghost" disabled={p.busy} onClick={p.onDisconnect}>
                Disconnect
              </Btn>
            ) : (
              <Btn t={t} tone="primary" disabled={p.busy} onClick={p.onConnect}>
                Connect
              </Btn>
            )}
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
        <Section title="On this page" t={t}>
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
                  "mt-1 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-2.5 text-[12px] font-medium transition-colors disabled:opacity-50",
                  t.divider,
                  t.sub,
                  "hover:border-trakt hover:text-trakt",
                )}
              >
                <Icon name="target" class="text-[14px]" />
                No recipe yet — set up with the picker
              </button>
              <p class={clsx("px-1 text-[11px] leading-relaxed", t.faint)}>
                Player in another frame? Press play so it loads, then reopen this popup to enable
                it.
              </p>
            </div>
          )}
        </Section>

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
