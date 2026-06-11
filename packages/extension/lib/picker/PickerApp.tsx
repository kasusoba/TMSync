import "@/lib/ui/theme.css";
import { loadRecipes } from "@/lib/recipes";
import { customRecipes, quickLinks } from "@/lib/storage";
import { PickerPanel } from "@/lib/ui/proto/PickerPanel";
import { sendMessage } from "@/messaging";
import { finder } from "@medv/finder";
import {
  type EngineContext,
  type Field,
  type LinkTemplates,
  readField,
  selectRecipe,
} from "@tmsync/shared";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  type DraftFieldKey,
  type RecipeDraft,
  autoDetectFields,
  buildRecipe,
  deriveQuickLink,
  emptyDraft,
  previewDraft,
  recipeMatchesHost,
  recipeToDraft,
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

type UrlPart = { text: string } | { num: string; ordinal: number };

/** Split the current href into text + clickable numeric chips (in order). */
function urlChips(): UrlPart[] {
  const href = location.href;
  const parts: UrlPart[] = [];
  let last = 0;
  let ordinal = 0;
  for (const m of href.matchAll(/\d+/g)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ text: href.slice(last, idx) });
    parts.push({ num: m[0], ordinal: ordinal++ });
    last = idx + m[0].length;
  }
  if (last < href.length) parts.push({ text: href.slice(last) });
  return parts;
}

export function PickerApp({ onClose }: { onClose: () => void }) {
  const ctx: EngineContext = useMemo(() => ({ document, url: location.href }), []);
  const parts = useMemo(urlChips, []);

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
  // Quick-link bridge: optionally create a "watch on this site" link on save,
  // pre-filled from the current URL (re-derived until the user edits it).
  const [qlEnabled, setQlEnabled] = useState(false);
  const [qlEdited, setQlEdited] = useState(false);
  const [qlTemplates, setQlTemplates] = useState<LinkTemplates>(() =>
    deriveQuickLink(draft, ctx.url),
  );

  // Populate ONLY from the user's own custom recipe — never from the library, so
  // fixing a wrong library recipe starts fresh rather than inheriting its fields.
  // Separately note if a library recipe covers this page (transparency); the
  // local save will shadow it (loadRecipes dedupes by urlPattern, custom-first).
  useEffect(() => {
    void (async () => {
      const [custom, links] = await Promise.all([customRecipes.getValue(), quickLinks.getValue()]);
      // Quick links are per-SITE — load this host's existing one so it's editable
      // from ANY page on the site (search page, listing, …), not only a media URL.
      const ql = links.find((s) => s.id === `ql-${location.hostname}`);
      if (ql) {
        setQlEnabled(true);
        setQlEdited(true); // keep the saved values; don't overwrite with a guess
        setQlTemplates({ movie: ql.movie, tv: ql.tv, anime: ql.anime, search: ql.search });
      }
      const saved = custom.find((r) => recipeMatchesHost(r, location.hostname));
      if (saved) {
        setDraft(recipeToDraft(saved));
        setName(saved.name);
        setEditingId(saved.id);
        return; // editing own recipe — no need for the library note
      }
      // No recipe here: reflect the quick link's tracker so the right URL fields show.
      if (ql?.tracker) setDraft((d) => ({ ...d, tracker: ql.tracker as typeof d.tracker }));
      const match = selectRecipe(await loadRecipes(), ctx);
      if (match) setLibraryCovers(match.name);
    })();
  }, [ctx]);

  // Re-derive the quick-link suggestion as the recipe shape changes — until the
  // user edits it by hand (then we leave their version alone).
  // biome-ignore lint/correctness/useExhaustiveDependencies: derive from draft shape
  useEffect(() => {
    if (!qlEdited) setQlTemplates(deriveQuickLink(draft, ctx.url));
  }, [
    draft.tracker,
    draft.mediaType,
    draft.fields.season,
    draft.fields.episode,
    qlEdited,
    ctx.url,
  ]);

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

  /** Use the Nth number in the URL for this field (reliable for season/episode). */
  function selectUrlToken(field: DraftFieldKey, ordinal: number) {
    const regex = urlTokenRegex(ordinal);
    setDraft((d) => ({
      ...d,
      fields: { ...d.fields, [field]: { source: "url", regex, group: 1, transforms: ["toInt"] } },
    }));
    setPicking(null);
    setHighlight(null);
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
    // A recipe needs a title (or manual mode); a quick link is independent and can
    // be saved on its own (it's per-SITE, not tied to this URL).
    const wantRecipe = draft.manual || draft.fields.title !== undefined;
    let savedRecipe = false;

    if (wantRecipe) {
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
      savedRecipe = true;
    }

    // Quick-link upsert for this host — independent of the recipe, so it works from
    // any page on the site (a search page, a listing, …), not only a media URL.
    if (qlEnabled) {
      const links = await quickLinks.getValue();
      const qid = `ql-${location.hostname}`;
      const entry = {
        id: qid,
        name,
        enabled: true,
        source: "user" as const,
        tracker: draft.tracker,
        movie: qlTemplates.movie?.trim() || undefined,
        tv: qlTemplates.tv?.trim() || undefined,
        anime: qlTemplates.anime?.trim() || undefined,
        search: qlTemplates.search?.trim() || undefined,
      };
      const nextLinks = links.some((s) => s.id === qid)
        ? links.map((s) => (s.id === qid ? { ...s, ...entry } : s))
        : [...links, entry];
      await quickLinks.setValue(nextLinks);
    }

    if (!savedRecipe && !qlEnabled) {
      return setStatus("Pick a title to scrobble, or turn on a quick link.");
    }
    setStatus(
      savedRecipe && qlEnabled
        ? "Saved recipe + quick link! Reload to start scrobbling."
        : savedRecipe
          ? "Saved! Reload the page to start scrobbling."
          : "Quick link saved.",
    );
  }

  const onQuickLinkChange = (field: "movie" | "tv" | "anime" | "search", value: string) => {
    setQlEdited(true);
    setQlTemplates((t) => ({ ...t, [field]: value }));
  };

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
          status={status}
          canSave={draft.manual || !!draft.fields.title || qlEnabled}
          onPick={(key) => setPicking(key)}
          onPickToken={(ord) => {
            if (picking && picking !== "manualKey") selectUrlToken(picking, ord);
          }}
          onClear={clearField}
          onClose={onClose}
          onSave={save}
          onCopy={copyJson}
          onNameChange={setName}
          quickLinkEnabled={qlEnabled}
          quickLink={qlTemplates}
          onQuickLinkToggle={setQlEnabled}
          onQuickLinkChange={onQuickLinkChange}
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
