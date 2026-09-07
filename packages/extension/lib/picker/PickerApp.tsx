import "@/lib/ui/theme.css";
import { newRecipeId, slugifyHost } from "@/lib/recipe-id";
import { loadRecipes } from "@/lib/recipes";
import { customRecipes } from "@/lib/storage";
import { useKeyShield } from "@/lib/ui/key-shield";
import { PickerPanel } from "@/lib/ui/kit/PickerPanel";
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
  defaultRecipeName,
  emptyDraft,
  previewDraft,
  recipeMatchesHost,
  recipeToDraft,
  splitNumbers,
  urlTokenRegex,
} from "./recipe-builder";
import { buildPalette, shapeOf, textTransforms } from "./sources";

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

export function PickerApp({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Keep keys typed in the picker (recipe name, search…) from firing page &
  // other-extension shortcuts — see useKeyShield.
  useKeyShield(rootRef);
  const ctx: EngineContext = useMemo(() => ({ document, url: location.href }), []);

  const [draft, setDraft] = useState<RecipeDraft>(() => {
    const base = emptyDraft(ctx.url);
    base.fields = autoDetectFields(ctx);
    // Intentionally NO domFingerprint / video selector from the page video: the
    // movie page often autoplays a muted background trailer, which is the wrong
    // element and an unstable match key. Match by urlPattern; the player frame's
    // own <video> is found at play time.
    return base;
  });
  const [name, setName] = useState(defaultRecipeName(location.hostname));
  const [picking, setPicking] = useState<DraftFieldKey | "manualKey" | null>(null);
  const [highlight, setHighlight] = useState<Rect | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // A page element was picked for a NUMBER field but holds several numbers (e.g.
  // "1x6 - Episode 6"), so ask which one before committing. Only the element path
  // needs this: every palette chip already names one specific number.
  const [domPick, setDomPick] = useState<{
    field: DraftFieldKey;
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

  // THE SOURCE PALETTE, rebuilt for the field being picked, because the chips a
  // source offers depend on the field's shape (numbers vs text segments), not on
  // which field it is. This is what makes every source available to every field.
  const palette = useMemo(
    () => (picking ? buildPalette(ctx, shapeOf(picking), { selectorFor: safeFinder }) : null),
    [ctx, picking],
  );

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
    commitFrom(
      field,
      { source: "dom", selector },
      (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
  }

  /** Commit a Field to whichever slot is being picked (a draft field, or the
   * manual remember-by key). The single write path for EVERY source. */
  function commitField(field: DraftFieldKey | "manualKey", value: Field) {
    setDraft((d) =>
      field === "manualKey"
        ? { ...d, manualKey: value }
        : { ...d, fields: { ...d.fields, [field]: value } },
    );
    setPicking(null);
    setHighlight(null);
    setStatus(null);
  }

  /**
   * Commit a value read straight off the page (a clicked element), shaping it for
   * the target field: text is cleaned, a number is isolated. When the text packs
   * several numbers ("1x6 - Episode 6") toInt would grab the FIRST one, so season
   * and episode would both read 1, so we ask which number instead.
   */
  function commitFrom(field: DraftFieldKey | "manualKey", base: Field, text: string) {
    if (shapeOf(field) === "text") {
      commitField(field, { ...base, transforms: textTransforms(text) });
      return;
    }
    const count = countNumbers(text);
    if (count === 0) {
      setStatus("That element holds no number.");
      return;
    }
    if (count > 1 && base.selector !== undefined && field !== "manualKey") {
      setDomPick({ field, selector: base.selector, text, parts: splitNumbers(text) });
      setStatus(null);
      return;
    }
    commitField(field, { ...base, transforms: ["trim", "toInt"] });
  }

  /** Commit the Nth number of the picked element (the "which number?" answer). */
  function selectDomNumber(ordinal: number) {
    if (!domPick) return;
    const { field, selector } = domPick;
    commitField(field, {
      source: "dom",
      selector,
      regex: urlTokenRegex(ordinal),
      group: 1,
      transforms: ["toInt"],
    });
    setDomPick(null);
  }

  /** Commit a palette chip: the URL, the page title, a player frame's src, a meta
   * tag or a JSON-LD path. Each chip already carries its finished Field, so every
   * source commits through the exact same line. */
  function selectChip(chipId: string) {
    const value = palette?.fields.get(chipId);
    if (!value || !picking) return;
    commitField(picking, value);
  }

  function clearField(field: DraftFieldKey) {
    setDraft((d) => {
      const fields = { ...d.fields };
      delete fields[field];
      return { ...d, fields };
    });
  }

  async function save() {
    // Stable, human-readable id (docs/IDENTITY-NAMESPACES.md): a host slug, unique
    // against existing recipe ids — so a re-authored site updates rather than dupes.
    const existing = await customRecipes.getValue();
    const id =
      editingId ??
      newRecipeId(
        location.hostname,
        existing.map((r) => r.id),
      );
    const built = buildRecipe(draft, { id, name });
    if (!built.ok) return setStatus(built.error);
    // Replace the recipe being edited (same id) and any other for the same
    // urlPattern — so we never leave a stale duplicate behind.
    const list = existing.filter(
      (r) => r.id !== built.recipe.id && r.match.urlPattern !== built.recipe.match.urlPattern,
    );
    await customRecipes.setValue([...list, built.recipe]);
    setEditingId(built.recipe.id);
    await sendMessage("registerSite", location.origin);
    setStatus("Saved! Reload the page to start scrobbling.");
  }

  async function copyJson() {
    const built = buildRecipe(draft, { id: slugifyHost(location.hostname), name });
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
      (preview.media.ids?.tmdb !== undefined ? `TMDB ${preview.media.ids.tmdb}` : "")
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
          urlPattern={draft.match.urlPattern}
          patternMatchesPage={(() => {
            try {
              return new RegExp(draft.match.urlPattern).test(location.href);
            } catch {
              return false;
            }
          })()}
          picking={
            picking
              ? picking === "manualKey"
                ? "remember-by element"
                : FIELD_LABELS[picking]
              : null
          }
          fields={(Object.keys(FIELD_LABELS) as DraftFieldKey[])
            .filter((key) => {
              // AniList-ONLY (dedicated anime site): resolves by title → cour and
              // passes episode as-is, so season/year/tmdbId aren't needed — ask for
              // just title + episode. With Trakt also on, show everything (Trakt +
              // the forward crosswalk need tmdbId/season).
              if (draft.trackers.length === 1 && draft.trackers[0] === "anilist")
                return key === "title" || key === "episode";
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
          sources={palette?.sources ?? []}
          domPick={
            domPick
              ? { label: FIELD_LABELS[domPick.field], text: domPick.text, parts: domPick.parts }
              : null
          }
          mediaType={draft.mediaType}
          trackers={draft.trackers}
          iframe={draft.video.frame === "iframe"}
          manual={draft.manual}
          manualKeyValue={draft.manualKey ? readField(draft.manualKey, ctx) : null}
          preview={
            draft.manual
              ? { ok: true, text: "Manual · pick each title from the badge" }
              : preview.ok
                ? { ok: true, text: previewText }
                : { ok: false, error: preview.error }
          }
          banner={!editingId && libraryCovers ? { kind: "library", name: libraryCovers } : null}
          siteRecipeNote={editingId ? null : siteRecipeName}
          status={status}
          canSave={
            draft.trackers.length > 0 &&
            (draft.manual || !!draft.fields.title || !!draft.fields.tmdbId)
          }
          onPick={(key) => {
            setDomPick(null); // a fresh pick supersedes a pending "which number?"
            // Pressing the armed field's own Pick again cancels, like Esc.
            setPicking((cur) => (cur === key ? null : key));
            setHighlight(null);
          }}
          onPickChip={selectChip}
          onPickDomNumber={selectDomNumber}
          onClear={(key) => {
            if (domPick?.field === key) setDomPick(null);
            clearField(key);
          }}
          onClose={onClose}
          onSave={save}
          onCopy={copyJson}
          onNameChange={setName}
          onUrlPatternChange={(v) =>
            setDraft((d) => ({ ...d, match: { ...d.match, urlPattern: v } }))
          }
          onMediaTypeChange={(v) => setDraft((d) => ({ ...d, mediaType: v }))}
          onTrackerToggle={(tracker) =>
            setDraft((d) => {
              const on = d.trackers.includes(tracker);
              const trackers = on
                ? d.trackers.filter((x) => x !== tracker)
                : [...d.trackers, tracker];
              // Enabling AniList implies an anime series with a real title — it's
              // never a manual (no-title) recipe.
              return { ...d, trackers, manual: tracker === "anilist" && !on ? false : d.manual };
            })
          }
          onIframeChange={(v) =>
            setDraft((d) => ({ ...d, video: { ...d.video, frame: v ? "iframe" : "auto" } }))
          }
          onManualChange={(v) => setDraft((d) => ({ ...d, manual: v }))}
          onPickManualKey={() => {
            setDomPick(null);
            setPicking((cur) => (cur === "manualKey" ? null : "manualKey"));
            setHighlight(null);
          }}
          onClearManualKey={() => setDraft((d) => ({ ...d, manualKey: undefined }))}
        />
      </div>
    </div>
  );
}
