import "@/lib/ui/theme.css";
import type { Tracker } from "@/lib/tracker/types";
import { type BadgeState, type BadgeStatus, onMessage, sendMessage } from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
import clsx from "clsx";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { Btn, Icon, IconBtn, tokens } from "./proto/kit";
import { Correction, EpisodePick, ManualPick, RateNote, RatingRow } from "./scrobble-panels";

const t = tokens("dark");

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

  const s = STATE[status.state];
  const summary = `TMSync · ${status.detail ?? s.label}${status.title ? ` — ${status.title}` : ""}`;

  // Minimized: a status dot with a soft glow.
  if (minimized) {
    return (
      <div class="fixed bottom-3.5 left-3.5 z-[2147483646] font-sans">
        <button
          type="button"
          class="grid place-items-center p-1.5"
          onClick={() => setMinimized(false)}
          title={summary}
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
    <div class="tmsync-pop fixed bottom-3.5 left-3.5 z-[2147483646] flex max-w-[340px] flex-col gap-2 font-sans">
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

      <div
        class={clsx(
          "inline-flex items-center gap-2.5 rounded-xl py-2 pr-2 pl-3 shadow-xl shadow-black/30",
          t.panel,
        )}
      >
        <span class={clsx("size-2.5 shrink-0 rounded-full", s.color)} />
        <button
          type="button"
          class="min-w-0 flex-1 text-left"
          onClick={() =>
            setPanel((p) =>
              p ? null : status.pick ? "manual" : status.needEpisode ? "episode" : "review",
            )
          }
          title={
            status.pick
              ? "Pick what you’re watching"
              : status.needEpisode
                ? "Set the episode you’re watching"
                : "Rate, note, or fix the match"
          }
        >
          <span class={clsx("block text-[12px] font-semibold", t.heading)}>
            TMSync · {status.detail ?? s.label}
          </span>
          {status.title && (
            <span class={clsx("block truncate text-[12px]", t.sub)}>{status.title}</span>
          )}
        </button>
        <IconBtn t={t} name="minimize" title="Minimize" onClick={() => setMinimized(true)} />
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
