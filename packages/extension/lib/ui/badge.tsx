import "@/lib/ui/theme.css";
import { type BadgePrefs, badgePrefs } from "@/lib/storage";
import type { Tracker } from "@/lib/tracker/types";
import { type BadgeState, type BadgeStatus, onMessage, sendMessage } from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
import clsx from "clsx";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { Btn, Icon, IconBtn, tokens } from "./proto/kit";
import { Correction, EpisodePick, ManualPick, RateNote, RatingRow } from "./scrobble-panels";

const t = tokens("dark");

/** Default anchor when the user hasn't dragged it (position === null). */
const DEFAULT_CORNER = "bottom-3.5 left-3.5";

type XY = { x: number; y: number };

/** Keep a dragged top-left inside the viewport, given the element's size. */
function clampXY(x: number, y: number, w: number, h: number): XY {
  const m = 6;
  return {
    x: Math.min(Math.max(m, x), Math.max(m, window.innerWidth - w - m)),
    y: Math.min(Math.max(m, y), Math.max(m, window.innerHeight - h - m)),
  };
}

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

/** How long the rating prompt stays up after a scrobble before auto-collapsing. */
const AUTO_COLLAPSE_MS = 12_000;

function BadgeRoot() {
  const [status, setStatus] = useState<BadgeStatus | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [panel, setPanel] = useState<null | "review" | "fix" | "manual" | "episode">(null);
  const [media, setMedia] = useState<ParsedMedia | null>(null);
  const [tracker, setTracker] = useState<Tracker>("trakt");
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [rewatchHidden, setRewatchHidden] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  // User pref: whether the in-page badge shows + its dragged position (the toolbar
  // icon is always the ambient indicator). Live-updated so changes apply at once.
  const [prefs, setPrefs] = useState<BadgePrefs>({ mode: "full", position: null });
  // Live dragged top-left; null = use the default corner. Seeded from prefs.
  const [pos, setPos] = useState<XY | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragged = useRef(false); // suppress the click that follows a drag

  useEffect(() => {
    void badgePrefs.getValue().then((v) => {
      setPrefs(v);
      setPos(v.position);
    });
    return badgePrefs.watch((v) => {
      if (!v) return;
      setPrefs(v);
      setPos(v.position);
    });
  }, []);

  // "Dot" mode keeps the badge collapsed to its status dot by default.
  useEffect(() => {
    if (prefs.mode === "dot") setMinimized(true);
  }, [prefs.mode]);

  // Keep the badge on-screen as its size changes (dot ↔ panel) or the window
  // resizes. Deferred via rAF (NOT a synchronous layout effect) so it yields each
  // frame — it can never busy-loop the main thread even if a measurement is odd.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-clamp on size change only
  useEffect(() => {
    if (!pos || !rootRef.current) return;
    const id = requestAnimationFrame(() => {
      if (!rootRef.current) return;
      const r = rootRef.current.getBoundingClientRect();
      const c = clampXY(pos.x, pos.y, r.width, r.height);
      if (c.x !== pos.x || c.y !== pos.y) setPos(c);
    });
    return () => cancelAnimationFrame(id);
  }, [pos, minimized, panel]);

  // Drag the badge by a handle (the dot, or the panel's status bar). Below a small
  // threshold it's a click (expand/minimize); past it, a move that persists.
  const startDrag = (e: PointerEvent) => {
    if (e.button !== 0 || !rootRef.current) return;
    const r = rootRef.current.getBoundingClientRect();
    const start = { sx: e.clientX, sy: e.clientY, bx: r.left, by: r.top, w: r.width, h: r.height };
    let moved = false;
    let last: XY = { x: r.left, y: r.top };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.sx;
      const dy = ev.clientY - start.sy;
      if (!moved && Math.hypot(dx, dy) > 4) moved = true;
      if (moved) {
        last = clampXY(start.bx + dx, start.by + dy, start.w, start.h);
        setPos(last);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) {
        dragged.current = true;
        void badgePrefs.setValue({ ...prefs, position: last });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // True (and resets) if the just-finished pointer interaction was a drag — so the
  // synthetic click after a drag doesn't also expand/minimize.
  const consumeDrag = () => {
    if (!dragged.current) return false;
    dragged.current = false;
    return true;
  };

  useEffect(() => {
    const off = onMessage("scrobbleStatus", ({ data }) => {
      if (data.hide) {
        // SPA navigated away from a scrobblable page — drop the badge and reset
        // per-session UI so the next match starts clean.
        setStatus(null);
        setPanel(null);
        setMedia(null);
        setMinimized(false);
        setPromptDismissed(false);
        return;
      }
      setStatus(data);
      setRewatchHidden(false); // a fresh status may carry a new rewatch prompt
    });
    return () => off();
  }, []);

  // Pull the tab's media + tracker once a session exists (needed for rating/note/fix).
  useEffect(() => {
    if (status && !media) {
      void sendMessage("getTabMedia", undefined).then((tab) => {
        if (tab) {
          setMedia(tab.media);
          setTracker(tab.tracker);
        }
      });
    }
  }, [status, media]);

  // Track whether this is a manual-mode site, so "wrong match?" re-opens the
  // manual picker (changing the remembered pick) rather than the correction UI.
  useEffect(() => {
    if (status) void sendMessage("getManualContext", undefined).then((c) => setManualMode(!!c));
  }, [status]);

  // After a watch lands in history, leave the rating prompt up for a moment then
  // auto-collapse to the dot so it gets out of the way.
  useEffect(() => {
    if (status?.state === "scrobbled" && panel === null && !minimized) {
      const id = setTimeout(() => setMinimized(true), AUTO_COLLAPSE_MS);
      return () => clearTimeout(id);
    }
  }, [status?.state, panel, minimized]);

  if (!status) return null;
  if (prefs.mode === "off") return null; // hidden — rely on the toolbar icon + popup

  const s = STATE[status.state];
  // Dragged position takes over; otherwise anchor to the default corner.
  const posStyle = pos ? { left: `${pos.x}px`, top: `${pos.y}px` } : undefined;
  const anchor = pos ? "" : DEFAULT_CORNER;
  const summary = `TMSync · ${status.detail ?? s.label}${status.title ? ` — ${status.title}` : ""}`;

  // Minimized: a status dot with a soft glow. The dot is also the drag handle.
  if (minimized) {
    return (
      <div ref={rootRef} class={clsx("fixed z-[2147483646] font-sans", anchor)} style={posStyle}>
        <button
          type="button"
          class="grid cursor-grab touch-none place-items-center p-1.5 active:cursor-grabbing"
          onPointerDown={startDrag}
          onClick={() => {
            if (consumeDrag()) return;
            setMinimized(false);
          }}
          title={`${summary} — drag to move`}
          aria-label={summary}
        >
          <span class={clsx("tmsync-dot size-3.5 rounded-full", s.color, s.glow)} />
        </button>
      </div>
    );
  }

  // Rating prompt: Trakt on any scrobble; AniList only when the cour completed.
  const showPrompt =
    status.state === "scrobbled" &&
    media !== null &&
    panel === null &&
    !promptDismissed &&
    (tracker !== "anilist" || status.completed === true);

  const confirmRewatch = () => {
    if (!media) return;
    setRewatchHidden(true); // background pushes the resulting status back
    void sendMessage("confirmRewatch", { media });
  };

  return (
    <div
      ref={rootRef}
      class={clsx(
        "tmsync-pop fixed z-[2147483646] flex max-w-[340px] flex-col gap-2 font-sans",
        anchor,
      )}
      style={posStyle}
    >
      {panel === "review" && media && (
        <RateNote
          media={media}
          tracker={tracker}
          t={t}
          onClose={() => setPanel(null)}
          onFix={() => setPanel(manualMode ? "manual" : "fix")}
        />
      )}
      {panel === "fix" && <Correction t={t} onClose={() => setPanel(null)} />}
      {panel === "manual" && (
        <ManualPick t={t} onClose={() => setPanel(null)} onDone={() => setPanel(null)} />
      )}
      {panel === "episode" && (
        <EpisodePick
          title={status.title}
          t={t}
          onClose={() => setPanel(null)}
          onDone={() => setPanel(null)}
        />
      )}

      {status.pick && panel === null && (
        <div
          class={clsx(
            "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
            t.panel,
          )}
        >
          <span class={clsx("whitespace-nowrap text-[12px] font-semibold", t.heading)}>
            What are you watching?
          </span>
          <Btn t={t} tone="primary" class="ml-auto" onClick={() => setPanel("manual")}>
            Pick title
          </Btn>
        </div>
      )}

      {status.needEpisode && panel === null && (
        <div
          class={clsx(
            "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
            t.panel,
          )}
        >
          <span class={clsx("whitespace-nowrap text-[12px] font-semibold", t.heading)}>
            Which episode?
          </span>
          <Btn t={t} tone="primary" class="ml-auto" onClick={() => setPanel("episode")}>
            Set episode
          </Btn>
        </div>
      )}

      {status.rewatch && panel === null && !rewatchHidden && (
        <div
          class={clsx(
            "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
            t.panel,
          )}
        >
          <span class="min-w-0">
            <span class={clsx("block whitespace-nowrap text-[12px] font-semibold", t.heading)}>
              Rewatching?
            </span>
            {status.title && (
              <span class={clsx("block max-w-[200px] truncate text-[11px]", t.sub)}>
                {status.title} · completed before
              </span>
            )}
          </span>
          <Btn t={t} tone="primary" class="ml-auto" onClick={confirmRewatch}>
            Start rewatch
          </Btn>
          <IconBtn t={t} name="x" title="Dismiss" onClick={() => setRewatchHidden(true)} />
        </div>
      )}

      {showPrompt && media && (
        <div
          class={clsx(
            "inline-flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
            t.panel,
          )}
        >
          <span class={clsx("whitespace-nowrap text-[12px] font-semibold", t.heading)}>
            {tracker === "anilist"
              ? "Rate this cour?"
              : `Rate ${media.season !== undefined ? "episode" : "movie"}?`}
          </span>
          <div class="flex-1">
            <RatingRow
              media={media}
              tracker={tracker}
              t={t}
              level={
                tracker === "anilist" ? "cour" : media.season !== undefined ? "episode" : "movie"
              }
              compact
            />
          </div>
          <button
            type="button"
            onClick={() => setPanel("review")}
            class={clsx(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
              t.ghost,
            )}
          >
            <Icon name="edit" class="text-[11px]" />
            Note
          </button>
          <IconBtn t={t} name="x" title="Dismiss" onClick={() => setPromptDismissed(true)} />
        </div>
      )}

      {/* The status bar doubles as the drag handle (drag to reposition). */}
      <div
        class={clsx(
          "inline-flex cursor-grab touch-none items-center gap-2.5 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30 active:cursor-grabbing",
          t.panel,
        )}
        onPointerDown={startDrag}
      >
        <span class={clsx("size-2.5 shrink-0 rounded-full", s.color)} />
        <button
          type="button"
          class="min-w-0 flex-1 cursor-pointer text-left"
          onClick={() => {
            if (consumeDrag()) return;
            setPanel((p) =>
              p ? null : status.pick ? "manual" : status.needEpisode ? "episode" : "review",
            );
          }}
          title={
            status.pick
              ? "Pick what you’re watching"
              : status.needEpisode
                ? "Set the episode you’re watching"
                : "Rate, note, or fix the match · drag the bar to move"
          }
        >
          <span class={clsx("block text-[12px] font-semibold", t.heading)}>
            TMSync · {status.detail ?? s.label}
          </span>
          {status.title && (
            <span class={clsx("block truncate text-[12px]", t.sub)}>{status.title}</span>
          )}
        </button>
        <IconBtn
          t={t}
          name="minimize"
          title="Minimize"
          onClick={() => {
            if (consumeDrag()) return;
            setMinimized(true);
          }}
        />
      </div>
    </div>
  );
}

export async function mountBadge(ctx: ContentScriptContext): Promise<void> {
  const ui = await createShadowRootUi(ctx, {
    name: "tmsync-badge",
    position: "overlay",
    anchor: "body",
    onMount: (container) => render(<BadgeRoot />, container),
    onRemove: (container) => container && render(null, container),
  });
  ui.mount();
}
