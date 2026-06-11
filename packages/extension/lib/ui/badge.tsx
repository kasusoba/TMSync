import "@/lib/ui/theme.css";
import type { RatingLevel, Tracker } from "@/lib/tracker/types";
import type { ResolvedIdentity, ReviewLevel, TraktSearchOption } from "@/lib/trakt/types";
import { type BadgeState, type BadgeStatus, onMessage, sendMessage } from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
import clsx from "clsx";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { Btn, Icon, IconBtn, tokens } from "./proto/kit";

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

function optionLabel(o: TraktSearchOption): string {
  return `${o.title}${o.year ? ` (${o.year})` : ""} · ${o.type}`;
}

/**
 * Keep keystrokes inside our inputs from reaching the page — otherwise typing a
 * note fires the site/player/other-extension keyboard shortcuts (f, k, space…).
 * Events from a shadow root still bubble to document, so we stop them here.
 */
const stopKeys = {
  onKeyDown: (e: KeyboardEvent) => e.stopPropagation(),
  onKeyUp: (e: KeyboardEvent) => e.stopPropagation(),
  onKeyPress: (e: KeyboardEvent) => e.stopPropagation(),
};

const PANEL = clsx("w-[300px] rounded-2xl p-3.5 shadow-2xl shadow-black/40", t.panel);
const NUMS = Array.from({ length: 10 }, (_, i) => i + 1);

/** 1–10 star scale. Hover to preview, click to set, click your current value to clear. */
function Stars({ value, onChoose }: { value: number | null; onChoose: (n: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const active = hover ?? value ?? 0;
  return (
    <div class="flex items-center gap-px" onMouseLeave={() => setHover(null)}>
      {NUMS.map((n) => (
        <button
          type="button"
          key={n}
          class={clsx(
            "px-px text-[18px] leading-none transition-colors",
            n <= active ? "text-amber-400" : "text-zinc-600 hover:text-amber-400/60",
          )}
          onMouseEnter={() => setHover(n)}
          onClick={() => onChoose(n)}
          aria-label={`${n} of 10`}
          title={`${n}/10`}
        >
          ★
        </button>
      ))}
      <span class={clsx("ml-1.5 min-w-[30px] text-[11px]", t.sub)}>
        {value ? `${value}/10` : "—"}
      </span>
    </div>
  );
}

/**
 * Your rating for the item at this level. Optimistic: the stars update instantly
 * and only revert if Trakt rejects the change (no waiting on the round-trip).
 */
function RatingRow({
  media,
  level,
  tracker,
  compact = false,
}: {
  media: ParsedMedia;
  level: RatingLevel;
  tracker: Tracker;
  compact?: boolean;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void sendMessage("getReview", { media, level, tracker }).then(
      (r) => live && setRating(r.rating),
    );
    return () => {
      live = false;
    };
  }, [media, level, tracker]);

  const choose = (n: number) => {
    const prev = rating;
    const next = n === rating ? null : n;
    setRating(next); // optimistic — instant
    setErr(null);
    void (
      next === null
        ? sendMessage("unrateItem", { media, level, tracker })
        : sendMessage("rateItem", { media, level, rating: next, tracker })
    ).then((out) => {
      if (!out.ok) {
        setRating(prev); // revert on failure
        setErr(out.error ?? "Failed");
      }
    });
  };

  return (
    <div>
      {!compact && <span class={clsx("mb-1 block text-[11px]", t.faint)}>Your rating</span>}
      <Stars value={rating} onChoose={choose} />
      {err && <span class="mt-1 block text-[11px] text-rose-400">{err}</span>}
    </div>
  );
}

const TRAKT_LEVELS: ReviewLevel[] = ["episode", "season", "show"];

/**
 * Rate + keep a single editable note for the matched item. Adapter-driven: Trakt
 * rates show/season/episode with a public comment (≥5 words, spoiler flag);
 * AniList rates the single cour entry with a private note (no spoiler, no minimum).
 * The level affordances come from the tracker, so the UI assumes no fixed set.
 */
function RateNote({
  media,
  tracker,
  onClose,
  onFix,
}: {
  media: ParsedMedia;
  tracker: Tracker;
  onClose: () => void;
  onFix: () => void;
}) {
  const isAniList = tracker === "anilist";
  const isShow = media.season !== undefined || media.episode !== undefined;
  // AniList: one "cour" level. Trakt: movie, or the show/season/episode tabs.
  const [level, setLevel] = useState<RatingLevel>(
    isAniList ? "cour" : isShow ? "episode" : "movie",
  );
  const [note, setNote] = useState("");
  const [spoiler, setSpoiler] = useState(false);
  const [hasNote, setHasNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setMsg(null);
    void sendMessage("getReview", { media, level, tracker }).then((r) => {
      setNote(r.note?.text ?? "");
      setSpoiler(r.note?.spoiler ?? false);
      setHasNote(!!r.note);
    });
  }, [media, level, tracker]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const out = await sendMessage("saveNote", { media, level, text: note, spoiler, tracker });
    if (out.ok) {
      setHasNote(true);
      setMsg(isAniList ? "Saved to AniList" : "Saved to Trakt");
    } else {
      setMsg(out.error ?? "Failed");
    }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    setMsg(null);
    const out = await sendMessage("deleteNote", { media, level, tracker });
    if (out.ok) {
      setNote("");
      setHasNote(false);
      setMsg("Deleted");
    } else {
      setMsg(out.error ?? "Failed");
    }
    setBusy(false);
  };

  return (
    <div class={PANEL}>
      <header class="mb-3 flex items-center justify-between">
        <strong class={clsx("text-[13px]", t.heading)}>
          {isAniList ? "Rate this cour" : "Rate & note"}
        </strong>
        <IconBtn t={t} name="x" title="Close" onClick={onClose} />
      </header>

      {/* Trakt-only level tabs (AniList rates the single cour entry). */}
      {!isAniList && isShow && (
        <div class="mb-3">
          <span class={clsx("mb-1 block text-[11px]", t.faint)}>Rate &amp; note the</span>
          <div class="flex gap-1">
            {TRAKT_LEVELS.map((l) => (
              <button
                type="button"
                key={l}
                onClick={() => setLevel(l)}
                class={clsx(
                  "flex-1 rounded-md py-1 text-[11px] capitalize transition-colors",
                  level === l ? "bg-ikura text-white" : t.ghost,
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="mb-3">
        <RatingRow media={media} level={level} tracker={tracker} />
      </div>

      <textarea
        {...stopKeys}
        rows={4}
        value={note}
        onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
        placeholder={
          isAniList ? "Private note on AniList…" : "Your note — public on Trakt, at least 5 words…"
        }
        class={clsx(
          "mb-2 w-full resize-none rounded-lg px-2.5 py-2 text-[12px] outline-none ring-inset focus:ring-2",
          t.input,
        )}
      />

      {/* Spoiler flag is a Trakt public-comment concept; AniList notes are private. */}
      {!isAniList && (
        <label class={clsx("mb-3 flex cursor-pointer items-center gap-2 text-[11px]", t.sub)}>
          <input
            type="checkbox"
            class="accent-trakt"
            checked={spoiler}
            onChange={(e) => setSpoiler((e.target as HTMLInputElement).checked)}
          />
          Mark as spoiler
        </label>
      )}

      <div class="flex items-stretch gap-2">
        <Btn
          t={t}
          tone="primary"
          class="flex-1"
          disabled={busy || note.trim().length === 0}
          onClick={save}
        >
          {hasNote ? "Update note" : isAniList ? "Save note" : "Post note"}
        </Btn>
        {hasNote && (
          <Btn t={t} tone="danger" title="Delete note" disabled={busy} onClick={remove}>
            <Icon name="trash" class="text-[13px]" />
          </Btn>
        )}
        {/* AniList has no in-badge correction flow in v1 — hide "wrong match?". */}
        {!isAniList && (
          <button
            type="button"
            onClick={onFix}
            class={clsx("ml-auto text-[12px] underline underline-offset-2", t.sub)}
          >
            Wrong match?
          </button>
        )}
      </div>
      {msg && <p class={clsx("mt-2 text-[11px]", t.sub)}>{msg}</p>}
    </div>
  );
}

/** The "fix match" panel: search Trakt and pick the correct entry. */
function Correction({ onClose }: { onClose: () => void }) {
  const [media, setMedia] = useState<ParsedMedia | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TraktSearchOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const tab = await sendMessage("getTabMedia", undefined);
      if (tab) {
        setMedia(tab.media);
        setQuery(tab.media.title);
      }
    })();
  }, []);

  const runSearch = async () => {
    setBusy(true);
    const type =
      media && (media.season !== undefined || media.episode !== undefined)
        ? "show"
        : media?.mediaType === "show"
          ? "show"
          : media?.mediaType === "movie"
            ? "movie"
            : undefined;
    setResults(await sendMessage("searchTrakt", { query, type }));
    setBusy(false);
  };

  const pick = async (o: TraktSearchOption) => {
    if (!media) return;
    setBusy(true);
    await sendMessage("saveCorrection", {
      media,
      identity: { mediaType: o.type, traktId: o.traktId, title: o.title, year: o.year },
    });
    setSaved(optionLabel(o));
    setBusy(false);
  };

  return (
    <div class={PANEL}>
      <header class="mb-3 flex items-center justify-between">
        <strong class={clsx("text-[13px]", t.heading)}>Fix match</strong>
        <IconBtn t={t} name="x" title="Close" onClick={onClose} />
      </header>
      {saved ? (
        <p class={clsx("rounded-lg px-2.5 py-2 text-[12px]", t.okBox)}>
          Corrected → {saved}. It’ll re-scrobble now.
        </p>
      ) : (
        <>
          <div class="mb-3 flex gap-2">
            <div class={clsx("flex flex-1 items-center gap-2 rounded-lg px-2.5", t.input)}>
              <Icon name="search" class={clsx("text-[14px]", t.faint)} />
              <input
                value={query}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") runSearch();
                }}
                onKeyUp={(e) => e.stopPropagation()}
                onKeyPress={(e) => e.stopPropagation()}
                placeholder="Search Trakt…"
                class="w-full bg-transparent py-1.5 text-[13px] outline-none"
              />
            </div>
            <Btn t={t} tone="primary" disabled={busy} onClick={runSearch}>
              Search
            </Btn>
          </div>
          <div class="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto">
            {results.length === 0 ? (
              <p class={clsx("py-1 text-[12px]", t.faint)}>
                {busy ? "Searching…" : "Search and pick the right title."}
              </p>
            ) : (
              results.map((o) => (
                <button
                  type="button"
                  key={`${o.type}-${o.traktId}`}
                  onClick={() => pick(o)}
                  disabled={busy}
                  class={clsx(
                    "truncate rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors disabled:opacity-50",
                    t.card,
                    t.heading,
                    "hover:ring-2 hover:ring-ikura",
                  )}
                >
                  {optionLabel(o)}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Manual-mode picker: on sites with no readable title (local-file players,
 * watch parties), the user tells TMSync what's playing. Search Trakt, choose
 * movie/show, give season+episode for a show. The pick is saved (and remembered
 * by the page's distinguishing key) via setManualMedia.
 */
function ManualPick({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [ctx, setCtx] = useState<{ recipeId: string; pageKey: string } | null>(null);
  const [type, setType] = useState<"movie" | "show">("movie");
  const [query, setQuery] = useState("");
  const [season, setSeason] = useState("");
  const [episode, setEpisode] = useState("");
  const [results, setResults] = useState<TraktSearchOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void sendMessage("getManualContext", undefined).then(setCtx);
  }, []);

  const runSearch = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setErr(null);
    setResults(await sendMessage("searchTrakt", { query, type }));
    setBusy(false);
  };

  const pick = async (o: TraktSearchOption) => {
    if (!ctx) return;
    let s: number | undefined;
    let e: number | undefined;
    if (type === "show") {
      s = Number.parseInt(season, 10);
      e = Number.parseInt(episode, 10);
      if (!Number.isFinite(s) || !Number.isFinite(e)) {
        setErr("Enter the season and episode numbers.");
        return;
      }
    }
    setBusy(true);
    setErr(null);
    const media: ParsedMedia =
      type === "movie"
        ? { mediaType: "movie", title: o.title, year: o.year }
        : { mediaType: "show", title: o.title, year: o.year, season: s, episode: e };
    const identity: ResolvedIdentity = {
      mediaType: o.type,
      traktId: o.traktId,
      title: o.title,
      year: o.year,
    };
    const out = await sendMessage("setManualMedia", {
      recipeId: ctx.recipeId,
      pageKey: ctx.pageKey,
      media,
      identity,
    });
    setBusy(false);
    if (out.ok) onDone();
    else setErr("Couldn’t save the pick.");
  };

  return (
    <div class={PANEL}>
      <header class="mb-3 flex items-center justify-between">
        <strong class={clsx("text-[13px]", t.heading)}>What are you watching?</strong>
        <IconBtn t={t} name="x" title="Close" onClick={onClose} />
      </header>

      <div class="mb-3 flex gap-1">
        {(["movie", "show"] as const).map((tt) => (
          <button
            type="button"
            key={tt}
            onClick={() => setType(tt)}
            class={clsx(
              "flex-1 rounded-md py-1 text-[11px] capitalize transition-colors",
              type === tt ? "bg-ikura text-white" : t.ghost,
            )}
          >
            {tt}
          </button>
        ))}
      </div>

      {type === "show" && (
        <div class="mb-3 flex gap-2">
          {[
            { label: "Season", value: season, set: setSeason },
            { label: "Episode", value: episode, set: setEpisode },
          ].map((f) => (
            <label key={f.label} class="flex-1">
              <span class={clsx("mb-1 block text-[11px]", t.faint)}>{f.label}</span>
              <input
                {...stopKeys}
                inputMode="numeric"
                value={f.value}
                onInput={(ev) => f.set((ev.target as HTMLInputElement).value)}
                placeholder="1"
                class={clsx(
                  "w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none ring-inset focus:ring-2",
                  t.input,
                )}
              />
            </label>
          ))}
        </div>
      )}

      <div class="mb-3 flex gap-2">
        <div class={clsx("flex flex-1 items-center gap-2 rounded-lg px-2.5", t.input)}>
          <Icon name="search" class={clsx("text-[14px]", t.faint)} />
          <input
            value={query}
            onInput={(ev) => setQuery((ev.target as HTMLInputElement).value)}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key === "Enter") runSearch();
            }}
            onKeyUp={(ev) => ev.stopPropagation()}
            onKeyPress={(ev) => ev.stopPropagation()}
            placeholder={`Search ${type}s on Trakt…`}
            class="w-full bg-transparent py-1.5 text-[13px] outline-none"
          />
        </div>
        <Btn t={t} tone="primary" disabled={busy} onClick={runSearch}>
          Search
        </Btn>
      </div>

      <div class="flex max-h-[200px] flex-col gap-1.5 overflow-y-auto">
        {results.length === 0 ? (
          <p class={clsx("py-1 text-[12px]", t.faint)}>
            {busy ? "Searching…" : "Search and pick the title you’re watching."}
          </p>
        ) : (
          results.map((o) => (
            <button
              type="button"
              key={`${o.type}-${o.traktId}`}
              onClick={() => pick(o)}
              disabled={busy}
              class={clsx(
                "truncate rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors disabled:opacity-50",
                t.card,
                t.heading,
                "hover:ring-2 hover:ring-ikura",
              )}
            >
              {optionLabel(o)}
            </button>
          ))
        )}
      </div>
      {err && <p class="mt-2 text-[11px] text-rose-400">{err}</p>}
    </div>
  );
}

/**
 * Episode chooser: a show page whose URL carries no episode (e.g. a Cineby
 * "?play=true" deep link) can't tell TMSync which episode is playing. The title
 * is already resolved — the user just supplies season + episode, which is
 * remembered for this URL so scrobbling can start.
 */
function EpisodePick({
  title,
  onClose,
  onDone,
}: {
  title?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [season, setSeason] = useState("1");
  const [episode, setEpisode] = useState("1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const s = Number.parseInt(season, 10);
    const e = Number.parseInt(episode, 10);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < 1) {
      setErr("Enter valid season and episode numbers.");
      return;
    }
    setBusy(true);
    setErr(null);
    const out = await sendMessage("setEpisode", { season: s, episode: e });
    setBusy(false);
    if (out.ok) onDone();
    else setErr("Couldn’t save the episode.");
  };

  return (
    <div class={PANEL}>
      <header class="mb-3 flex items-center justify-between">
        <strong class={clsx("text-[13px]", t.heading)}>Which episode?</strong>
        <IconBtn t={t} name="x" title="Close" onClick={onClose} />
      </header>
      {title && <p class={clsx("mb-2 truncate text-[12px]", t.sub)}>{title}</p>}
      <p class={clsx("mb-3 text-[11px]", t.faint)}>
        This page’s URL doesn’t say which episode is playing. Set it so TMSync can scrobble.
      </p>
      <div class="mb-3 flex gap-2">
        {[
          { label: "Season", value: season, set: setSeason },
          { label: "Episode", value: episode, set: setEpisode },
        ].map((f) => (
          <label key={f.label} class="flex-1">
            <span class={clsx("mb-1 block text-[11px]", t.faint)}>{f.label}</span>
            <input
              {...stopKeys}
              inputMode="numeric"
              value={f.value}
              onInput={(ev) => f.set((ev.target as HTMLInputElement).value)}
              placeholder="1"
              class={clsx(
                "w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none ring-inset focus:ring-2",
                t.input,
              )}
            />
          </label>
        ))}
      </div>
      <Btn t={t} tone="primary" class="w-full" disabled={busy} onClick={submit}>
        {busy ? "Saving…" : "Set episode & scrobble"}
      </Btn>
      {err && <p class="mt-2 text-[11px] text-rose-400">{err}</p>}
    </div>
  );
}

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
    // Don't auto-expand on every status: while minimized the dot color keeps
    // tracking state live, so the user always sees TMSync is working without it
    // popping back open on each play/pause/timeupdate.
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
  // auto-collapse to the dot so it gets out of the way. Cancelled if a panel is
  // open (mid note/fix) so we never minimize from under the user.
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

  // Rating prompt: Trakt on any scrobble; AniList only when the cour completed
  // (you rate a cour once at the end, not after every episode).
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
          onClose={() => setPanel(null)}
          onFix={() => setPanel(manualMode ? "manual" : "fix")}
        />
      )}
      {panel === "fix" && <Correction onClose={() => setPanel(null)} />}
      {panel === "manual" && (
        <ManualPick onClose={() => setPanel(null)} onDone={() => setPanel(null)} />
      )}
      {panel === "episode" && (
        <EpisodePick
          title={status.title}
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
