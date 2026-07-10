import type { FrameNode } from "@/lib/diagnostics/frame-tree";
import clsx from "clsx";
import { Btn, Icon, type Tokens } from "./kit";

export interface FrameInspectorProps {
  t: Tokens;
  /** Flattened (pre-order) frame nodes with `depth`; null until the first scan. */
  nodes: FrameNode[] | null;
  busy?: boolean;
  onEnable?: (origin: string) => void;
  onDisable?: (origin: string) => void;
  /** Author a recipe inside this frame (injects the picker into it). */
  onSetupFrame?: (origin: string, frameId: number) => void;
}

function host(origin: string, url: string): string {
  if (origin && origin !== "null") return origin.replace(/^https?:\/\//, "");
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function mmss(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The video status pill for a frame: where (and whether) a real player lives. */
function VideoTag({ t, node }: { t: Tokens; node: FrameNode }) {
  if (!node.reached) {
    return (
      <span class={clsx("rounded px-1.5 py-0.5 text-[10px] font-medium", t.chip)}>not scanned</span>
    );
  }
  if (!node.hasVideo) {
    return <span class={clsx("text-[10px]", t.faint)}>no video</span>;
  }
  const v = node.videos.find((x) => !(x.loop && x.muted));
  const playing = node.hasActiveVideo;
  return (
    <span
      class={clsx(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        playing ? "bg-emerald-500/15 text-emerald-400" : t.chip,
      )}
    >
      <Icon name="play" class="text-[9px]" fill />
      {playing ? "playing" : "paused"}
      {v && v.duration > 0 && (
        <span class="opacity-70">
          {mmss(v.currentTime)}/{mmss(v.duration)}
        </span>
      )}
    </span>
  );
}

/**
 * Frame inspector — the in-extension stand-in for the DevTools frame panel.
 * Renders the stitched iframe tree (indented by depth) so the user can see which
 * frame actually holds the player and enable the deep one driving it.
 */
export function FrameInspector(p: FrameInspectorProps) {
  const { t, nodes } = p;
  return (
    <div class={clsx("space-y-1.5 rounded-xl p-2.5", t.card)}>
      {nodes === null ? (
        <p class={clsx("px-1 py-2 text-[11px] leading-relaxed", t.faint)}>
          Mapping this page's frames…
        </p>
      ) : nodes.length === 0 ? (
        <p class={clsx("px-1 py-2 text-[11px]", t.faint)}>No frames found on this page.</p>
      ) : (
        <div class="space-y-1">
          {nodes.map((n) => (
            <div
              key={`${n.frameId ?? "x"}:${n.url}`}
              style={{ marginLeft: `${n.depth * 14}px` }}
              class={clsx(
                "flex items-center gap-2 rounded-lg px-2 py-1.5",
                n.hasActiveVideo ? "bg-emerald-500/10 ring-1 ring-emerald-500/25" : t.chip,
              )}
            >
              {n.depth > 0 && <span class={clsx("text-[11px] leading-none", t.faint)}>└</span>}
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <code
                  class={clsx("truncate font-mono text-[11px]", t.heading)}
                  title={n.url || n.origin}
                >
                  {host(n.origin, n.url)}
                </code>
                <span class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  {n.isTop && <span class={clsx("text-[10px]", t.faint)}>top</span>}
                  {!n.isTop && (
                    <span class={clsx("inline-flex items-center gap-0.5 text-[10px]", t.faint)}>
                      <Icon name="frame" class="text-[9px]" />
                      frame
                    </span>
                  )}
                  <VideoTag t={t} node={n} />
                </span>
              </span>
              {n.origin && n.origin !== "null" ? (
                <span class="flex shrink-0 items-center gap-1">
                  {/* Author a recipe inside this frame — for embeds whose title/
                      episode text is only reachable from inside the iframe. */}
                  {!n.isTop && n.frameId !== null && p.onSetupFrame && (
                    <Btn
                      t={t}
                      tone="ghost"
                      disabled={p.busy}
                      title="Set up a recipe inside this frame"
                      onClick={() => p.onSetupFrame?.(n.origin, n.frameId as number)}
                    >
                      <Icon name="target" class="text-[13px] text-ikura" />
                    </Btn>
                  )}
                  {n.enabled ? (
                    <Btn
                      t={t}
                      tone="ghost"
                      disabled={p.busy}
                      onClick={() => p.onDisable?.(n.origin)}
                    >
                      <Icon name="check" class="text-[12px] text-emerald-500" />
                      Enabled
                    </Btn>
                  ) : (
                    <Btn
                      t={t}
                      tone="primary"
                      disabled={p.busy}
                      onClick={() => p.onEnable?.(n.origin)}
                    >
                      Enable
                    </Btn>
                  )}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
