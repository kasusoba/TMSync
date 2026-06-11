import "@/lib/ui/theme.css";
import { loadRecipes } from "@/lib/recipes";
import { customRecipes } from "@/lib/storage";
import { PickerPanel } from "@/lib/ui/proto/PickerPanel";
import { sendMessage } from "@/messaging";
import { finder } from "@medv/finder";
import { type EngineContext, type Field, readField, selectRecipe } from "@tmsync/shared";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  type DraftFieldKey,
  type RecipeDraft,
  autoDetectFields,
  buildRecipe,
  emptyDraft,
  previewDraft,
  queryParamRegex,
  recipeMatchesHost,
  recipeToDraft,
  splitTitle,
  titleSegmentRegex,
  urlTokenRegex,
} from "./recipe-builder";

const HOST_TAG = "tmsync-picker";
const FIELD_LABELS: Record<DraftFieldKey, string> = {
  title: "Title",
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
  const ctx: EngineContext = useMemo(() => ({ document, url: location.href }), []);
  const parts = useMemo(urlChips, []);
  // Segments of the page's <title> (for sites whose real title is only there).
  const titleInfo = useMemo(() => splitTitle(document.title), []);

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
    const onMove = (e: MouseEvent) => {
      if (inOurUi(e)) return setHighlight(null);
      const el = e.target as Element | null;
      if (!el?.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      setHighlight({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const onClick = (e: MouseEvent) => {
      if (inOurUi(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as Element | null;
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
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
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
    const transforms: Field["transforms"] =
      field === "title" ? ["trim", "collapseSpaces"] : ["trim", "toInt"];
    setDraft((d) => ({
      ...d,
      fields: { ...d.fields, [field]: { source: "dom", selector, transforms } },
    }));
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
  const previewText = preview.ok
    ? `${preview.media.mediaType}: ${preview.media.title}${
        preview.media.year ? ` (${preview.media.year})` : ""
      }${
        preview.media.season !== undefined
          ? ` S${preview.media.season}E${preview.media.episode ?? "?"}`
          : ""
      }`
    : "";

  return (
    <div class="pointer-events-none fixed inset-0 z-[2147483647] font-sans text-zinc-100">
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
            // AniList resolves by title → cour and passes episode as-is: season is
            // never used, and year isn't part of the AniList search. Hide both so
            // an anime recipe only asks for what it needs (title + episode).
            .filter((key) =>
              draft.tracker === "anilist" ? key === "title" || key === "episode" : true,
            )
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
          canSave={draft.manual || !!draft.fields.title}
          onPick={(key) => setPicking(key)}
          onPickToken={(ord, paramKey) => {
            if (picking && picking !== "manualKey") selectUrlToken(picking, ord, paramKey);
          }}
          onPickTitleSegment={selectTitleSegment}
          onClear={clearField}
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
