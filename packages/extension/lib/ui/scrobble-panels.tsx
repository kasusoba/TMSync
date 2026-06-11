import type { RatingLevel, Tracker } from "@/lib/tracker/types";
import type { ResolvedIdentity, ReviewLevel, TraktSearchOption } from "@/lib/trakt/types";
import { type BadgeState, type BadgeStatus, sendMessage } from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
import clsx from "clsx";
import { useEffect, useState } from "preact/hooks";
import { Btn, Icon, IconBtn, type Tokens } from "./proto/kit";

/**
 * The interactive scrobble panels — rate/note, fix-match, manual pick, episode
 * pick. Shared by the in-page badge AND the popup so both surfaces can act on a
 * session (the toolbar icon is ambient; either surface can answer prompts).
 * Parameterised by `t` (tokens) and self-contained (each talks to the background
 * via sendMessage), so dropping one into any container just works.
 */

const NUMS = Array.from({ length: 10 }, (_, i) => i + 1);
const TRAKT_LEVELS: ReviewLevel[] = ["episode", "season", "show"];

export const panelClass = (t: Tokens): string =>
  clsx("w-full rounded-2xl p-3.5 shadow-2xl shadow-black/40", t.panel);

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

/** 1–10 star scale. Hover to preview, click to set, click your current value to clear. */
export function Stars({
  value,
  onChoose,
  t,
}: {
  value: number | null;
  onChoose: (n: number) => void;
  t: Tokens;
}) {
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
 * and only revert if the tracker rejects the change (no waiting on the round-trip).
 */
export function RatingRow({
  media,
  level,
  tracker,
  t,
  compact = false,
}: {
  media: ParsedMedia;
  level: RatingLevel;
  tracker: Tracker;
  t: Tokens;
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
      <Stars value={rating} onChoose={choose} t={t} />
      {err && <span class="mt-1 block text-[11px] text-rose-400">{err}</span>}
    </div>
  );
}

/**
 * Rate + keep a single editable note for the matched item. Adapter-driven: Trakt
 * rates show/season/episode with a public comment (≥5 words, spoiler flag);
 * AniList rates the single cour entry with a private note (no spoiler, no minimum).
 */
export function RateNote({
  media,
  tracker,
  t,
  onClose,
  onFix,
}: {
  media: ParsedMedia;
  tracker: Tracker;
  t: Tokens;
  onClose: () => void;
  onFix: () => void;
}) {
  const isAniList = tracker === "anilist";
  const isShow = media.season !== undefined || media.episode !== undefined;
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
    <div class={panelClass(t)}>
      <header class="mb-3 flex items-center justify-between">
        <strong class={clsx("text-[13px]", t.heading)}>
          {isAniList ? "Rate this cour" : "Rate & note"}
        </strong>
        <IconBtn t={t} name="x" title="Close" onClick={onClose} />
      </header>

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
        <RatingRow media={media} level={level} tracker={tracker} t={t} />
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

/** The "fix match" panel: search Trakt and pick the correct entry. `tabId` is set
 * when shown from the popup (a content script infers its own tab from the sender). */
export function Correction({
  t,
  tabId,
  onClose,
}: {
  t: Tokens;
  tabId?: number;
  onClose: () => void;
}) {
  const [media, setMedia] = useState<ParsedMedia | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TraktSearchOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const tab = await sendMessage("getTabMedia", { tabId });
      if (tab) {
        setMedia(tab.media);
        setQuery(tab.media.title);
      }
    })();
  }, [tabId]);

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
      tabId,
    });
    setSaved(optionLabel(o));
    setBusy(false);
  };

  return (
    <div class={panelClass(t)}>
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
 * Manual-mode picker: on sites with no readable title, the user tells TMSync
 * what's playing. Search Trakt, choose movie/show, give season+episode for a show.
 */
export function ManualPick({
  t,
  tabId,
  onClose,
  onDone,
}: {
  t: Tokens;
  tabId?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [ctx, setCtx] = useState<{ recipeId: string; pageKey: string } | null>(null);
  const [type, setType] = useState<"movie" | "show">("movie");
  const [query, setQuery] = useState("");
  const [season, setSeason] = useState("");
  const [episode, setEpisode] = useState("");
  const [results, setResults] = useState<TraktSearchOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void sendMessage("getManualContext", { tabId }).then(setCtx);
  }, [tabId]);

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
      tabId,
    });
    setBusy(false);
    if (out.ok) onDone();
    else setErr("Couldn’t save the pick.");
  };

  return (
    <div class={panelClass(t)}>
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
 * Episode chooser: a show page whose URL carries no episode can't tell TMSync
 * which episode is playing. The title is resolved — the user supplies season +
 * episode, remembered for this URL so scrobbling can start.
 */
export function EpisodePick({
  title,
  t,
  tabId,
  onClose,
  onDone,
}: {
  title?: string;
  t: Tokens;
  tabId?: number;
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
    const out = await sendMessage("setEpisode", { season: s, episode: e, tabId });
    setBusy(false);
    if (out.ok) onDone();
    else setErr("Couldn’t save the episode.");
  };

  return (
    <div class={panelClass(t)}>
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

const STATE_DOT: Record<BadgeState, string> = {
  idle: "bg-zinc-400",
  watching: "bg-emerald-500",
  paused: "bg-amber-500",
  scrobbled: "bg-sky-500",
  stopped: "bg-zinc-500",
  error: "bg-rose-500",
};

/**
 * The popup's "now scrobbling" surface — status line + whichever prompt/panel is
 * relevant (rewatch / episode / pick / rate / fix). The popup counterpart of the
 * in-page badge: same panels, but tab-scoped via an explicit `tabId` (the popup
 * isn't a tab). `onRefresh` lets the popup re-read status after a tab-affecting
 * action so the surface reflects the new state.
 */
export function NowPlaying({
  status,
  media,
  tracker,
  tabId,
  t,
  onRefresh,
}: {
  status: BadgeStatus;
  media: ParsedMedia | null;
  tracker: Tracker;
  tabId: number;
  t: Tokens;
  onRefresh?: () => void;
}) {
  const [panel, setPanel] = useState<null | "review" | "fix" | "manual" | "episode">(null);
  const [rewatchBusy, setRewatchBusy] = useState(false);
  const done = () => {
    setPanel(null);
    onRefresh?.();
  };

  if (panel === "review" && media) {
    return (
      <RateNote
        media={media}
        tracker={tracker}
        t={t}
        onClose={() => setPanel(null)}
        onFix={() => setPanel("fix")}
      />
    );
  }
  if (panel === "fix") return <Correction t={t} tabId={tabId} onClose={() => setPanel(null)} />;
  if (panel === "manual") {
    return <ManualPick t={t} tabId={tabId} onClose={() => setPanel(null)} onDone={done} />;
  }
  if (panel === "episode") {
    return (
      <EpisodePick
        t={t}
        tabId={tabId}
        title={status.title}
        onClose={() => setPanel(null)}
        onDone={done}
      />
    );
  }

  const confirmRewatch = async () => {
    if (!media) return;
    setRewatchBusy(true);
    await sendMessage("confirmRewatch", { media, tabId });
    setRewatchBusy(false);
    onRefresh?.();
  };

  const idle = !status.pick && !status.needEpisode && !status.rewatch;
  return (
    <div class={clsx("space-y-2 rounded-xl p-3", t.card)}>
      <div class="flex items-center gap-2">
        <span class={clsx("size-2.5 shrink-0 rounded-full", STATE_DOT[status.state])} />
        <span class="min-w-0 flex-1">
          <span class={clsx("block text-[12px] font-semibold", t.heading)}>
            TMSync · {status.detail ?? status.state}
          </span>
          {status.title && (
            <span class={clsx("block truncate text-[12px]", t.sub)}>{status.title}</span>
          )}
        </span>
      </div>

      {status.pick && (
        <Btn t={t} tone="primary" class="w-full" onClick={() => setPanel("manual")}>
          Pick title
        </Btn>
      )}
      {status.needEpisode && (
        <Btn t={t} tone="primary" class="w-full" onClick={() => setPanel("episode")}>
          Set episode
        </Btn>
      )}
      {status.rewatch && (
        <Btn t={t} tone="primary" class="w-full" disabled={rewatchBusy} onClick={confirmRewatch}>
          {rewatchBusy ? "Starting…" : "Start rewatch"}
        </Btn>
      )}
      {idle && media && (
        <div class="flex gap-2">
          <Btn t={t} tone="ghost" class="flex-1" onClick={() => setPanel("review")}>
            <Icon name="edit" class="text-[12px]" />
            Rate / note
          </Btn>
          {tracker !== "anilist" && (
            <Btn t={t} tone="ghost" class="flex-1" onClick={() => setPanel("fix")}>
              <Icon name="search" class="text-[12px]" />
              Fix match
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}
