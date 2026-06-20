import "@/lib/ui/theme.css";
import { loadRecipes } from "@/lib/recipes";
import { customRecipes } from "@/lib/storage";
import { useKeyShield } from "@/lib/ui/key-shield";
import { PickerPanel } from "@/lib/ui/proto/PickerPanel";
import { sendMessage } from "@/messaging";
import { finder } from "@medv/finder";
import { type EngineContext, type Field, readField, selectRecipe } from "@tmsync/shared";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type DraftFieldKey,
  type NumberPart,
  type RecipeDraft,
  autoDetectFields,
  buildRecipe,
  countNumbers,
  emptyDraft,
  previewDraft,
  queryParamRegex,
  recipeMatchesHost,
  recipeToDraft,
  splitNumbers,
  splitTitle,
  titleSegmentRegex,
  urlTokenRegex,
} from "./recipe-builder";

const HOST_TAG = "tmsync-picker";
const FIELD_LABELS: Record<DraftFieldKey, string> = {
  title: "Title",
  tmdbId: "TMDB ID",
  year: "Year",
  season: "Season",
  episode: "Episode",
};

function safeFinder(el: Element): string | undefined {
  try {
    return finder(el);
  } catch {
    return undefined;
  }
}

/** Is the event targeting our own picker UI (vs. a page element)? */
function inOurUi(e: Event): boolean {
  return e
    .composedPath()
    .some((n) => n instanceof HTMLElement && n.tagName.toLowerCase() === HOST_TAG);
}

/** An element with its own visible text node (not just nested children). */
function hasDirectText(el: Element): boolean {
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "") return true;
  }
  return false;
}

/**
 * The best element to pick at a screen point. Video players overlay a fullscreen
 * click-catcher (the play/pause layer), so `event.target` is usually the whole
 * page — useless for grabbing the title/episode text drawn in a corner. Instead
 * walk the FULL stack under the cursor (elementsFromPoint sees through the
 * overlay) and choose the SMALLEST element that owns visible text, skipping our
 * own UI and near-fullscreen overlays. Falls back to the smallest non-overlay
 * element, else the topmost.
 */
function candidateAt(x: number, y: number): Element | null {
  const stack = document
    .elementsFromPoint(x, y)
    .filter((el) => el.tagName.toLowerCase() !== HOST_TAG);
  if (stack.length === 0) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const isOverlay = (r: DOMRect) => r.width >= vw * 0.9 && r.height >= vh * 0.9;

  let bestText: Element | null = null;
  let bestTextArea = Number.POSITIVE_INFINITY;
  let bestAny: Element | null = null;
  let bestAnyArea = Number.POSITIVE_INFINITY;
  for (const el of stack) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area === 0 || isOverlay(r)) continue;
    if (area < bestAnyArea) {
      bestAny = el;
      bestAnyArea = area;
    }
    if (hasDirectText(el) && area < bestTextArea) {
      bestText = el;
      bestTextArea = area;
    }
  }
  return bestText ?? bestAny ?? stack[0] ?? null;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

type UrlPart = { text: string } | { num: string; ordinal: number; paramKey?: string };

/**
 * Split the current href into text + clickable numeric chips (in order). A number
 * that's a query-param value (`?…&season=1`) carries its `paramKey`, so the picker
 * can generate a robust key-anchored regex instead of a positional one.
 */
function urlChips(): UrlPart[] {
  const href = location.href;
  const parts: UrlPart[] = [];
  let last = 0;
  let ordinal = 0;
  for (const m of href.matchAll(/\d+/g)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ text: href.slice(last, idx) });
    const paramKey = /[?&]([\w.-]+)=$/.exec(href.slice(0, idx))?.[1];
    parts.push({ num: m[0], ordinal: ordinal++, paramKey });
    last = idx + m[0].length;
  }
  if (last < href.length) parts.push({ text: href.slice(last) });
  return parts;
}

export function PickerApp({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Keep keys typed in the picker (recipe name, search…) from firing page &
  // other-extension shortcuts — see useKeyShield.
  useKeyShield(rootRef);
  const ctx: EngineContext = useMemo(() => ({ document, url: location.href }), []);
  const parts = useMemo(urlChips, []);
  // Segments of the page's <title> (for sites whose real title is only there).
  const titleInfo = useMemo(() => splitTitle(document.title), []);
  // Cross-origin player iframes: the season/episode often live in the embed's
  // src (e.g. .../embed/tv/276161/1/6), which the top frame CAN read even though
  // the player UI inside the iframe is unreachable. Offer those numbers to pick.
  const playerFrames = useMemo<{ selector: string; src: string; parts: NumberPart[] }[]>(() => {
    const out: { selector: string; src: string; parts: NumberPart[] }[] = [];
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      const raw = (f as HTMLIFrameElement).getAttribute("src");
      if (!raw) continue;
      let url: URL;
      try {
        url = new URL(raw, location.href);
      } catch {
        continue;
      }
      // cross-origin embeds with at least one number — same-origin/number-less
      // frames are almost never the player and would just add noise.
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (url.origin === location.origin || !/\d/.test(raw)) continue;
      const selector = safeFinder(f);
      if (selector && out.length < 4) out.push({ selector, src: raw, parts: splitNumbers(raw) });
    }
    return out;
  }, []);

  const [draft, setDraft] = useState<RecipeDraft>(() => {
    const base = emptyDraft(ctx.url);
    base.fields = autoDetectFields(ctx);
    // Intentionally NO domFingerprint / video selector from the page video: the
    // movie page often autoplays a muted background trailer, which is the wrong
    // element and an unstable match key. Match by urlPattern; the player frame's
    // own <video> is found at play time.
    return base;
  });
  const [name, setName] = useState(location.hostname);
  const [picking, setPicking] = useState<DraftFieldKey | "manualKey" | null>(null);
  const [highlight, setHighlight] = useState<Rect | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // A DOM element was picked for season/episode but holds several numbers (e.g.
  // "1x6 – Episode 6") — ask which one before committing the field.
  const [domPick, setDomPick] = useState<{
    field: "season" | "episode";
    selector: string;
    text: string;
    parts: NumberPart[];
  } | null>(null);
  // Set once we've loaded the user's OWN saved recipe for this site — we then
  // edit it in place (keep its id) instead of creating a duplicate.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Name of a LIBRARY recipe that already covers this page (when the user has no
  // override yet) — saving here creates a local override that wins over it.
  const [libraryCovers, setLibraryCovers] = useState<string | null>(null);
  // Name of an existing recipe for THIS SITE that doesn't cover the current URL
  // (so we note it rather than misleadingly entering "edit" on, say, a search page).
  const [siteRecipeName, setSiteRecipeName] = useState<string | null>(null);

  // Populate ONLY from the user's own custom recipe — never from the library, so
  // fixing a wrong library recipe starts fresh rather than inheriting its fields.
  // Separately note if a library recipe covers this page (transparency); the
  // local save will shadow it (loadRecipes dedupes by urlPattern, custom-first).
  useEffect(() => {
    void (async () => {
      const custom = await customRecipes.getValue();
      // Enter EDIT mode only when the user's own recipe actually applies to THIS
      // page — so a non-matching URL (a search/listing page) shows a fresh
      // "Set up site", not a misleading "Update recipe" for a different path.
      const own = selectRecipe(custom, ctx);
      if (own) {
        setDraft(recipeToDraft(own));
        setName(own.name);
        setEditingId(own.id);
        return; // editing own recipe — no need for the library note
      }
      // A recipe exists for this site but not this URL — note it instead of editing it.
      const siteRecipe = custom.find((r) => recipeMatchesHost(r, location.hostname));
      if (siteRecipe) setSiteRecipeName(siteRecipe.name);
      const match = selectRecipe(await loadRecipes(), ctx);
      if (match) setLibraryCovers(match.name);
    })();
  }, [ctx]);

  // Element-picking mode: highlight on hover, capture the next page click.
  useEffect(() => {
    if (!picking) return;
    // The element we'd commit. Captured continuously on hover/press because a
    // player's control bar auto-hides the instant you click — so the element
    // under the cursor at PRESS time is far more reliable than at click time.
    let target: Element | null = null;

    const onMove = (e: MouseEvent) => {
      if (inOurUi(e)) {
        setHighlight(null);
        return;
      }
      // Highlight the element we'd actually pick (the tight text box under the
      // player overlay), not the topmost full-page catcher.
      const el = candidateAt(e.clientX, e.clientY);
      target = el;
      if (!el) return setHighlight(null);
      const r = el.getBoundingClientRect();
      setHighlight({ top: r.top, left: r.left, width: r.width, height: r.height });
    };

    // Swallow the player's own press handlers (seek/pause) so a pick doesn't
    // also scrub the video, and lock in the target before the controls vanish.
    const swallowPress = (e: Event) => {
      if (inOurUi(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const me = e as MouseEvent;
      target = candidateAt(me.clientX, me.clientY) ?? target;
    };

    const onClick = (e: MouseEvent) => {
      if (inOurUi(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = target ?? candidateAt(e.clientX, e.clientY);
      if (el) selectField(picking, el);
      setPicking(null);
      setHighlight(null);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPicking(null);
        setHighlight(null);
      }
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("pointerdown", swallowPress, true);
    window.addEventListener("mousedown", swallowPress, true);
    window.addEventListener("mouseup", swallowPress, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("pointerdown", swallowPress, true);
      window.removeEventListener("mousedown", swallowPress, true);
      window.removeEventListener("mouseup", swallowPress, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picking]);

  function selectField(field: DraftFieldKey | "manualKey", el: Element) {
    const selector = safeFinder(el);
    if (!selector) {
      setStatus("Couldn't build a selector for that element.");
      return;
    }
    if (field === "manualKey") {
      setDraft((d) => ({
        ...d,
        manualKey: { source: "dom", selector, transforms: ["trim", "collapseSpaces"] },
      }));
      setStatus(null);
      return;
    }
    // Season/episode from an element that packs several numbers (e.g.
    // "Teach You a Lesson: 1x6 – Episode 6"): toInt would grab the FIRST number,
    // so season and episode would both read 1. Ask which number instead.
    if (field === "season" || field === "episode") {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (countNumbers(text) > 1) {
        setDomPick({ field, selector, text, parts: splitNumbers(text) });
        setStatus(null);
        return;
      }
    }

    const transforms: Field["transforms"] =
      field === "title" ? ["trim", "collapseSpaces"] : ["trim", "toInt"];
    setDraft((d) => ({
      ...d,
      fields: { ...d.fields, [field]: { source: "dom", selector, transforms } },
    }));
    setStatus(null);
  }

  /** Commit a season/episode DOM field to the Nth number of the picked element. */
  function selectDomNumber(ordinal: number) {
    if (!domPick) return;
    const { field, selector } = domPick;
    setDraft((d) => ({
      ...d,
      fields: {
        ...d.fields,
        [field]: {
          source: "dom",
          selector,
          regex: urlTokenRegex(ordinal),
          group: 1,
          transforms: ["toInt"],
        },
      },
    }));
    setDomPick(null);
    setStatus(null);
  }

  /** Use a URL number for this field — a query-param value by NAME when possible
   * (robust), else the Nth number positionally. */
  function selectUrlToken(field: DraftFieldKey, ordinal: number, paramKey?: string) {
    const regex = paramKey ? queryParamRegex(paramKey) : urlTokenRegex(ordinal);
    setDraft((d) => ({
      ...d,
      fields: { ...d.fields, [field]: { source: "url", regex, group: 1, transforms: ["toInt"] } },
    }));
    setPicking(null);
    setHighlight(null);
    setStatus(null);
  }

  /** Use the Nth number of a player iframe's `src` for the field being picked —
   * for embeds that carry the season/episode in their URL (a DOM field reading
   * the `src` attribute, so it re-reads live at scrobble time). */
  function selectFrameToken(selector: string, ordinal: number) {
    if (!picking || picking === "manualKey") return;
    setDraft((d) => ({
      ...d,
      fields: {
        ...d.fields,
        [picking]: {
          source: "dom",
          selector,
          attr: "src",
          regex: urlTokenRegex(ordinal),
          group: 1,
          transforms: ["toInt"],
        },
      },
    }));
    setPicking(null);
    setHighlight(null);
    setStatus(null);
  }

  /** Use the Nth `separator`-delimited segment of the page <title> as the title —
   * for SPA players whose only readable title is `document.title`. */
  function selectTitleSegment(index: number) {
    if (!titleInfo.separator) return;
    const regex = titleSegmentRegex(titleInfo.separator, index);
    setDraft((d) => ({
      ...d,
      fields: {
        ...d.fields,
        title: { source: "title", regex, group: 1, transforms: ["trim", "collapseSpaces"] },
      },
    }));
    setStatus(null);
  }

  function clearField(field: DraftFieldKey) {
    setDraft((d) => {
      const fields = { ...d.fields };
      delete fields[field];
      return { ...d, fields };
    });
  }

  async function save() {
    const id = editingId ?? `custom-${location.hostname}-${Date.now()}`;
    const built = buildRecipe(draft, { id, name });
    if (!built.ok) return setStatus(built.error);
    // Replace the recipe being edited (same id) and any other for the same
    // urlPattern — so we never leave a stale duplicate behind.
    const list = (await customRecipes.getValue()).filter(
      (r) => r.id !== built.recipe.id && r.match.urlPattern !== built.recipe.match.urlPattern,
    );
    await customRecipes.setValue([...list, built.recipe]);
    setEditingId(built.recipe.id);
    await sendMessage("registerSite", location.origin);
    setStatus("Saved! Reload the page to start scrobbling.");
  }

  async function copyJson() {
    const built = buildRecipe(draft, { id: `custom-${location.hostname}`, name });
    if (!built.ok) return setStatus(built.error);
    try {
      await navigator.clipboard.writeText(JSON.stringify(built.recipe, null, 2));
      setStatus("Recipe JSON copied to clipboard.");
    } catch {
      setStatus("Couldn't access the clipboard.");
    }
  }

  const preview = previewDraft(draft, ctx);
  const previewName = preview.ok
    ? preview.media.title ||
      (preview.media.tmdbId !== undefined ? `TMDB ${preview.media.tmdbId}` : "")
    : "";
  const previewText = preview.ok
    ? `${preview.media.mediaType}: ${previewName}${
        preview.media.year ? ` (${preview.media.year})` : ""
      }${
        preview.media.season !== undefined
          ? ` S${preview.media.season}E${preview.media.episode ?? "?"}`
          : ""
      }`
    : "";

  return (
    <div
      ref={rootRef}
      class="pointer-events-none fixed inset-0 z-[2147483647] font-sans text-zinc-100"
    >
      {highlight && (
        <div
          class="pointer-events-none fixed rounded-sm bg-trakt/10 ring-2 ring-trakt"
          style={{
            top: `${highlight.top}px`,
            left: `${highlight.left}px`,
            width: `${highlight.width}px`,
            height: `${highlight.height}px`,
          }}
        />
      )}

      <div class="pointer-events-auto fixed right-4 bottom-4">
        <PickerPanel
          variant="dark"
          mode={editingId ? "edit" : "setup"}
          name={name}
          picking={
            picking
              ? picking === "manualKey"
                ? "remember-by element"
                : FIELD_LABELS[picking]
              : null
          }
          fields={(Object.keys(FIELD_LABELS) as DraftFieldKey[])
            .filter((key) => {
              // AniList resolves by title → cour and passes episode as-is: season
              // is never used, and year isn't part of the AniList search. Hide both
              // so an anime recipe only asks for what it needs (title + episode).
              if (draft.tracker === "anilist") return key === "title" || key === "episode";
              // A movie has no season/episode — offering those rows invites picking
              // a stray number (e.g. the id) that flips resolution to the tv namespace.
              if (draft.mediaType === "movie") return key !== "season" && key !== "episode";
              return true;
            })
            .map((key) => {
              const field = draft.fields[key];
              return {
                key,
                label: FIELD_LABELS[key],
                value: field ? readField(field, ctx) : null,
                source: field?.source,
              };
            })}
          urlParts={parts}
          titleParts={titleInfo.parts}
          domPick={
            domPick ? { field: domPick.field, text: domPick.text, parts: domPick.parts } : null
          }
          playerFrames={playerFrames.map((f) => ({ src: f.src, parts: f.parts }))}
          mediaType={draft.mediaType}
          tracker={draft.tracker}
          iframe={draft.video.frame === "iframe"}
          manual={draft.manual}
          manualKeyValue={draft.manualKey ? readField(draft.manualKey, ctx) : null}
          preview={
            draft.manual
              ? { ok: true, text: "Manual — pick each title from the badge" }
              : preview.ok
                ? { ok: true, text: previewText }
                : { ok: false, error: preview.error }
          }
          banner={!editingId && libraryCovers ? { kind: "library", name: libraryCovers } : null}
          siteRecipeNote={editingId ? null : siteRecipeName}
          status={status}
          canSave={draft.manual || !!draft.fields.title || !!draft.fields.tmdbId}
          onPick={(key) => {
            setDomPick(null); // a fresh pick supersedes a pending "which number?"
            setPicking(key);
          }}
          onPickToken={(ord, paramKey) => {
            if (picking && picking !== "manualKey") selectUrlToken(picking, ord, paramKey);
          }}
          onPickTitleSegment={selectTitleSegment}
          onPickDomNumber={selectDomNumber}
          onPickFrameToken={(frameIndex, ordinal) => {
            const frame = playerFrames[frameIndex];
            if (frame) selectFrameToken(frame.selector, ordinal);
          }}
          onClear={(key) => {
            if (domPick?.field === key) setDomPick(null);
            clearField(key);
          }}
          onClose={onClose}
          onSave={save}
          onCopy={copyJson}
          onNameChange={setName}
          onMediaTypeChange={(v) => setDraft((d) => ({ ...d, mediaType: v }))}
          onTrackerChange={(tracker) =>
            setDraft((d) => {
              if (tracker !== "anilist") return { ...d, tracker };
              // Anime → AniList is series-only (episode required), always has a
              // title (so never manual), and ignores season + year — drop any
              // that were picked so they aren't saved.
              const { season: _s, year: _y, ...fields } = d.fields;
              return { ...d, tracker, mediaType: "show", manual: false, fields };
            })
          }
          onIframeChange={(v) =>
            setDraft((d) => ({ ...d, video: { ...d.video, frame: v ? "iframe" : "auto" } }))
          }
          onManualChange={(v) => setDraft((d) => ({ ...d, manual: v }))}
          onPickManualKey={() => setPicking("manualKey")}
          onClearManualKey={() => setDraft((d) => ({ ...d, manualKey: undefined }))}
        />
      </div>
    </div>
  );
}
