import type { AniListSearchOption } from "@/lib/anilist/client";
import type { RatingLevel, Tracker, WatchedEpisode, WatchedState } from "@/lib/tracker/types";
import type { ResolvedIdentity, ReviewLevel, TraktSearchOption } from "@/lib/trakt/types";
import {
  type BadgeState,
  type BadgeStatus,
  type TrackerResolution,
  sendMessage,
} from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
import clsx from "clsx";
import { useEffect, useState } from "preact/hooks";
import { AniListMark, Btn, Icon, IconBtn, type Tokens, TraktMark } from "./proto/kit";

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

/**
 * Shared panel header. The whole bar is a drag handle (`[data-tmsync-drag]` — the
 * in-page badge drags the popup by it). An optional Back returns to the previous
 * panel (e.g. correction → rate); Close dismisses. Buttons are excluded from the
 * drag by the badge's handler so they still click.
 */
function PanelHeader({
  t,
  title,
  onBack,
  onClose,
}: {
  t: Tokens;
  title: string;
  onBack?: () => void;
  onClose: () => void;
}) {
  return (
    <header data-tmsync-drag class="mb-3 flex items-center justify-between gap-2">
      <span class="flex min-w-0 items-center gap-1">
        {onBack && <IconBtn t={t} name="back" title="Back" onClick={onBack} />}
        <strong class={clsx("truncate text-[13px]", t.heading)}>{title}</strong>
      </span>
      <IconBtn t={t} name="x" title="Close" onClick={onClose} />
    </header>
  );
}

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
        {value ? `${value}/10` : "·"}
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

const trackerName = (tk: Tracker): string => (tk === "anilist" ? "AniList" : "Trakt");

/**
 * The per-tracker destinations readout for the now-playing view (badge + popup):
 * what each enabled tracker resolved to, each with a "fix" (edit) that opens the
 * matching correction panel. Correction lives HERE — where the match is shown — not
 * buried in the rate/note composer. Does its own `resolveAll`.
 */
export function TrackingRows({
  t,
  media,
  trackers,
  onFix,
}: {
  t: Tokens;
  media: ParsedMedia;
  trackers: Tracker[];
  onFix: (tracker: Tracker) => void;
}) {
  const [resolutions, setResolutions] = useState<TrackerResolution[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key on the tracker set
  useEffect(() => {
    setResolutions(null);
    void sendMessage("resolveAll", { media, trackers }).then(setResolutions);
  }, [media, trackers.join(",")]);
  const resFor = (tk: Tracker) => resolutions?.find((r) => r.tracker === tk);
  // Trakt is always fixable; AniList only when we have a tmdbId to key the override.
  const canFix = (tk: Tracker) =>
    tk === "trakt" || (tk === "anilist" && media.ids?.tmdb !== undefined);

  return (
    <div>
      <span class={clsx("mb-1 block text-[11px]", t.faint)}>Tracking</span>
      <div class="space-y-1">
        {trackers.map((tk) => {
          const res = resFor(tk);
          const detail =
            res == null
              ? "…"
              : res.resolved
                ? `→ ${res.title ?? "matched"}`
                : res.reason === "no_match"
                  ? `not on ${trackerName(tk)}`
                  : res.reason === "ambiguous"
                    ? "ambiguous mapping"
                    : "not found";
          return (
            <div
              key={tk}
              class={clsx(
                "flex items-center gap-1 rounded-lg pr-1 pl-2.5",
                t.card,
                !res?.resolved && "opacity-70",
              )}
            >
              <span class="flex min-w-0 flex-1 items-center gap-2 py-1.5">
                {tk === "anilist" ? <AniListMark class="size-4" /> : <TraktMark class="size-4" />}
                <span class={clsx("shrink-0 text-[12px] font-medium", t.heading)}>
                  {trackerName(tk)}
                </span>
                <span class={clsx("ml-1 min-w-0 flex-1 truncate text-[10px]", t.faint)}>
                  {detail}
                </span>
              </span>
              {canFix(tk) && (
                <IconBtn
                  t={t}
                  name="edit"
                  title={`Fix ${trackerName(tk)} match`}
                  onClick={() => onFix(tk)}
                />
              )}
            </div>
          );
        })}
      </div>
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
  trackers,
  t,
  onClose,
  onBack,
}: {
  media: ParsedMedia;
  /** The item's enabled trackers (multi-track). */
  trackers: Tracker[];
  t: Tokens;
  onClose: () => void;
  /** Back to the now-playing view (correction now lives there, not here). */
  onBack?: () => void;
}) {
  const isShow = media.season !== undefined || media.episode !== undefined;
  const hasTrakt = trackers.includes("trakt");

  // Levels: a movie has just "movie"; a show is episode/season/show. But the level
  // picker is a Trakt concept — AniList rates only the cour (≈ the "show" level). So
  // an AniList-only show has no picker and sits at "show" (its cour).
  const levels: RatingLevel[] = isShow ? ["episode", "season", "show"] : ["movie"];
  const showLevelPicker = isShow && hasTrakt;
  const [level, setLevel] = useState<RatingLevel>(
    isShow && !hasTrakt ? "show" : (levels[0] ?? "movie"),
  );

  // What each enabled tracker ACTUALLY resolves to for this item (async). Gates
  // the targets: e.g. a non-anime show enabled for AniList (Boondocks on a general
  // site) resolves to nothing there, so AniList isn't a real destination.
  const [resolutions, setResolutions] = useState<TrackerResolution[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key on the tracker set
  useEffect(() => {
    setResolutions(null);
    void sendMessage("resolveAll", { media, trackers }).then(setResolutions);
  }, [media, trackers.join(",")]);
  const resFor = (tk: Tracker) => resolutions?.find((r) => r.tracker === tk);
  // Optimistic until resolutions load, so opening the panel doesn't briefly block.
  const resolvedOk = (tk: Tracker) => {
    const r = resFor(tk);
    return r ? r.resolved : true;
  };

  // AniList rates only the cour (≈ the whole series), so it's a valid target only
  // on the top "show" level; Trakt rates whatever level is picked. AND the tracker
  // must actually have resolved the item.
  const levelOk = (tk: Tracker): boolean => tk === "trakt" || level === "show";
  const applicable: Tracker[] = trackers.filter((tk) => levelOk(tk) && resolvedOk(tk));
  const [selected, setSelected] = useState<Set<Tracker>>(new Set(trackers));
  const targets = applicable.filter((tk) => selected.has(tk));
  const trackerLevel = (tk: Tracker): RatingLevel => (tk === "anilist" ? "cour" : level);

  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [spoiler, setSpoiler] = useState(false);
  const [hasNote, setHasNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Seed the score + note from the primary target (first applicable, prefer a
  // selected one) so editing shows what's already there.
  const primary = targets[0] ?? applicable[0] ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: primary encodes tracker+level
  useEffect(() => {
    setMsg(null);
    if (!primary) {
      setRating(null);
      setNote("");
      setSpoiler(false);
      setHasNote(false);
      return;
    }
    void sendMessage("getReview", { media, level: trackerLevel(primary), tracker: primary }).then(
      (r) => {
        setRating(r.rating);
        setNote(r.note?.text ?? "");
        setSpoiler(r.note?.spoiler ?? false);
        setHasNote(!!r.note);
      },
    );
  }, [media, level, primary]);

  const spoilerApplies = targets.includes("trakt");
  const canSubmit = targets.length > 0 && (rating !== null || note.trim().length > 0) && !busy;

  const toggleTarget = (tk: Tracker) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tk)) next.delete(tk);
      else next.add(tk);
      return next;
    });

  // One Submit fans out the staged score + note to every selected tracker, at that
  // tracker's level (Trakt = picked level; AniList = its cour). Spoiler is Trakt-only.
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setMsg(null);
    const fails: string[] = [];
    for (const tk of targets) {
      const lv = trackerLevel(tk);
      if (rating !== null) {
        const r = await sendMessage("rateItem", { media, level: lv, rating, tracker: tk });
        if (!r.ok) fails.push(`${trackerName(tk)}: ${r.error ?? "rating failed"}`);
      }
      if (note.trim()) {
        const n = await sendMessage("saveNote", {
          media,
          level: lv,
          text: note,
          spoiler: tk === "trakt" ? spoiler : false,
          tracker: tk,
        });
        if (!n.ok) fails.push(`${trackerName(tk)}: ${n.error ?? "note failed"}`);
      }
    }
    if (note.trim()) setHasNote(true);
    setMsg(fails.length ? fails.join(" · ") : `Saved to ${targets.map(trackerName).join(" & ")}`);
    setBusy(false);
  };

  const removeNote = async () => {
    setBusy(true);
    setMsg(null);
    for (const tk of targets) {
      await sendMessage("deleteNote", { media, level: trackerLevel(tk), tracker: tk });
    }
    setNote("");
    setHasNote(false);
    setMsg("Deleted");
    setBusy(false);
  };

  const notePlaceholder = !spoilerApplies
    ? "Private note on AniList…"
    : targets.includes("anilist")
      ? "Public comment on Trakt · private note on AniList…"
      : "Your note · public on Trakt, at least 5 words…";

  return (
    <div class={panelClass(t)}>
      <PanelHeader t={t} title="Rate & note" onBack={onBack} onClose={onClose} />

      {showLevelPicker && (
        <div class="mb-3">
          <span class={clsx("mb-1 block text-[11px]", t.faint)}>Rate &amp; note the</span>
          <div class="flex gap-1">
            {levels.map((l) => (
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
        <span class={clsx("mb-1 block text-[11px]", t.faint)}>Send to</span>
        <div class="space-y-1">
          {trackers.map((tk) => {
            const res = resFor(tk);
            const canSend = applicable.includes(tk);
            const on = canSend && selected.has(tk);
            // Resolved but on the wrong tab (AniList on episode/season): make it a
            // shortcut to the level it CAN rate rather than a dead disabled row.
            const wrongLevel = !!res?.resolved && !levelOk(tk);
            const detail =
              res == null
                ? "…"
                : res.resolved
                  ? levelOk(tk)
                    ? `→ ${res.title ?? "matched"}`
                    : "whole entry only · tap for “show”"
                  : res.reason === "no_match"
                    ? `not on ${trackerName(tk)}`
                    : res.reason === "ambiguous"
                      ? "ambiguous mapping"
                      : "not found";
            return (
              <button
                type="button"
                key={tk}
                disabled={!canSend && !wrongLevel}
                onClick={() => (canSend ? toggleTarget(tk) : wrongLevel && setLevel("show"))}
                class={clsx(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ring-inset transition",
                  t.card,
                  on ? "ring-2 ring-ikura" : "ring-1 ring-transparent",
                  !canSend && !wrongLevel && "opacity-60",
                )}
              >
                {tk === "anilist" ? <AniListMark class="size-4" /> : <TraktMark class="size-4" />}
                <span class={clsx("shrink-0 text-[12px] font-medium", t.heading)}>
                  {trackerName(tk)}
                </span>
                <span class={clsx("ml-1 min-w-0 flex-1 truncate text-[10px]", t.faint)}>
                  {detail}
                </span>
                {on && <Icon name="check" class="shrink-0 text-[12px] text-ikura" />}
              </button>
            );
          })}
        </div>
      </div>

      <div class="mb-3">
        <span class={clsx("mb-1 block text-[11px]", t.faint)}>Your rating</span>
        <Stars value={rating} onChoose={(n) => setRating(n === rating ? null : n)} t={t} />
      </div>

      <textarea
        {...stopKeys}
        rows={4}
        value={note}
        onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
        placeholder={notePlaceholder}
        class={clsx(
          "mb-2 w-full resize-none rounded-lg px-2.5 py-2 text-[12px] outline-none ring-inset focus:ring-2",
          t.input,
        )}
      />

      {spoilerApplies && (
        <label class={clsx("mb-3 flex cursor-pointer items-center gap-2 text-[11px]", t.sub)}>
          <input
            type="checkbox"
            class="accent-trakt"
            checked={spoiler}
            onChange={(e) => setSpoiler((e.target as HTMLInputElement).checked)}
          />
          Mark as spoiler
          <span class={t.faint} title="Only applies to Trakt public comments">
            <Icon name="info" class="text-[12px]" />
          </span>
        </label>
      )}

      <div class="flex items-stretch gap-2">
        <Btn t={t} tone="primary" class="flex-1" disabled={!canSubmit} onClick={submit}>
          Save
        </Btn>
        {hasNote && (
          <Btn t={t} tone="danger" title="Delete note" disabled={busy} onClick={removeNote}>
            <Icon name="trash" class="text-[13px]" />
          </Btn>
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
  onBack,
}: {
  t: Tokens;
  tabId?: number;
  onClose: () => void;
  onBack?: () => void;
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
      <PanelHeader t={t} title="Fix match" onBack={onBack} onClose={onClose} />
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
 * The AniList "fix match" panel (multi-track) — the derived-tracker analogue of
 * {@link Correction}: search AniList and PIN the right entry, mark it "Not on
 * AniList", or clear back to the automatic (Fribb) match. All local overrides above
 * the crosswalk. Same panel shape as the Trakt fixer for consistency.
 */
export function AniListCorrection({
  t,
  tabId,
  onClose,
  onBack,
}: {
  t: Tokens;
  tabId?: number;
  onClose: () => void;
  onBack?: () => void;
}) {
  const [media, setMedia] = useState<ParsedMedia | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AniListSearchOption[]>([]);
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
    setResults(await sendMessage("searchAniList", { query }));
    setBusy(false);
  };
  const apply = async (label: string, send: Promise<{ ok: boolean }>) => {
    if (!media) return;
    setBusy(true);
    await send;
    setSaved(label);
    setBusy(false);
  };
  const pick = (o: AniListSearchOption) =>
    apply(
      `${o.title}${o.year ? ` (${o.year})` : ""}`,
      sendMessage("setAniListMatch", { media: media as ParsedMedia, anilistId: o.id, tabId }),
    );

  return (
    <div class={panelClass(t)}>
      <PanelHeader t={t} title="Fix AniList match" onBack={onBack} onClose={onClose} />
      {saved ? (
        <p class={clsx("rounded-lg px-2.5 py-2 text-[12px]", t.okBox)}>
          Set → {saved}. It’ll re-resolve now.
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
                placeholder="Search AniList…"
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
                {busy ? "Searching…" : "Search and pick the right anime."}
              </p>
            ) : (
              results.map((o) => (
                <button
                  type="button"
                  key={o.id}
                  onClick={() => pick(o)}
                  disabled={busy}
                  class={clsx(
                    "truncate rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors disabled:opacity-50",
                    t.card,
                    t.heading,
                    "hover:ring-2 hover:ring-ikura",
                  )}
                >
                  {o.title}
                  {o.year ? ` (${o.year})` : ""}
                  {o.format ? ` · ${o.format.toLowerCase()}` : ""}
                </button>
              ))
            )}
          </div>
          <div class={clsx("mt-3 flex items-center gap-4 border-t pt-2.5", t.divider)}>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                apply(
                  "Not on AniList",
                  sendMessage("setAniListMatch", {
                    media: media as ParsedMedia,
                    anilistId: null,
                    tabId,
                  }),
                )
              }
              class={clsx("text-[11px] underline underline-offset-2", t.sub)}
            >
              Not on AniList
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                apply(
                  "automatic match",
                  sendMessage("resetAniListMatch", { media: media as ParsedMedia, tabId }),
                )
              }
              class={clsx("text-[11px] underline underline-offset-2", t.sub)}
            >
              Use automatic match
            </button>
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
      <PanelHeader t={t} title="What are you watching?" onClose={onClose} />

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
      <PanelHeader t={t} title="Which episode?" onClose={onClose} />
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
function epLabel(e: WatchedEpisode): string {
  return e.season !== undefined ? `S${e.season}E${e.number}` : `Ep ${e.number}`;
}

/**
 * One-line "where am I in this show" summary for the popup. The two trackers'
 * shapes differ (AniList = linear count; Trakt = a set that can have gaps), so the
 * phrasing differs too — see WatchedState. Returns null when there's nothing useful.
 */
function watchedSummary(w: WatchedState): string | null {
  if (w.tracker === "anilist") {
    if (w.watchedCount === 0) return w.next ? `Not started · next ${epLabel(w.next)}` : null;
    return `Watched ${w.watchedCount}${w.total !== null ? ` / ${w.total}` : ""}`;
  }
  const parts: string[] = [];
  if (w.lastWatched) parts.push(`Last ${epLabel(w.lastWatched)}`);
  if (w.next) parts.push(`next ${epLabel(w.next)}`);
  else if (w.lastWatched) parts.push("caught up");
  if (parts.length === 0) return null;
  return parts.join(" · ") + (w.hasGaps ? " · gaps" : "");
}

export function NowPlaying({
  status,
  media,
  tracker,
  trackers,
  tabId,
  t,
  onRefresh,
}: {
  status: BadgeStatus;
  media: ParsedMedia | null;
  /** Primary tracker (drives the quick prompt / watched line). */
  tracker: Tracker;
  /** Enabled tracker set (the rate/note composer fans out across it). */
  trackers: Tracker[];
  tabId: number;
  t: Tokens;
  onRefresh?: () => void;
}) {
  const [panel, setPanel] = useState<
    null | "review" | "fix" | "anilist-fix" | "manual" | "episode"
  >(null);
  const [rewatchBusy, setRewatchBusy] = useState(false);
  const [watched, setWatched] = useState<WatchedState | null>(null);
  const done = () => {
    setPanel(null);
    onRefresh?.();
  };

  // Pull the viewer's watched progress for the "last watched / next up" line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch when the scrobble state changes so a fresh watch updates the line
  useEffect(() => {
    let alive = true;
    void sendMessage("getWatchedState", { tabId }).then((w) => {
      if (alive) setWatched(w);
    });
    return () => {
      alive = false;
    };
  }, [tabId, status.state]);

  if (panel === "review" && media) {
    return (
      <RateNote
        media={media}
        trackers={trackers}
        t={t}
        onClose={() => setPanel(null)}
        onBack={() => setPanel(null)}
      />
    );
  }
  if (panel === "fix")
    return (
      <Correction
        t={t}
        tabId={tabId}
        onClose={() => setPanel(null)}
        onBack={() => setPanel(null)}
      />
    );
  if (panel === "anilist-fix")
    return (
      <AniListCorrection
        t={t}
        tabId={tabId}
        onClose={() => setPanel(null)}
        onBack={() => setPanel(null)}
      />
    );
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
          {watched &&
            (() => {
              const line = watchedSummary(watched);
              return line ? (
                <span class={clsx("mt-0.5 block truncate text-[11px] opacity-70", t.sub)}>
                  {line}
                </span>
              ) : null;
            })()}
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
        <>
          <TrackingRows
            t={t}
            media={media}
            trackers={trackers}
            onFix={(tk) => setPanel(tk === "anilist" ? "anilist-fix" : "fix")}
          />
          <Btn t={t} tone="ghost" class="w-full" onClick={() => setPanel("review")}>
            <Icon name="edit" class="text-[12px]" />
            Rate / note
          </Btn>
        </>
      )}
    </div>
  );
}
