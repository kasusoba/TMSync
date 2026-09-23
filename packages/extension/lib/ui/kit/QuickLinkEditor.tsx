import { defaultRecipeName } from "@/lib/picker/recipe-builder";
import type { QuickLinkTracker, Tracker } from "@/lib/tracker/types";
import {
  ANILIST_PLACEHOLDERS,
  type LinkTemplates,
  TRAKT_PLACEHOLDERS,
  linkHost,
  placeholderHint,
  withLinkHost,
} from "@tmsync/shared";
import clsx from "clsx";
import { useState } from "preact/hooks";
import { TrackerTab } from "./TrackerTab";
import { Btn, Icon, type Tokens } from "./kit";

/** A saved quick link's editable shape (per-site "watch on" templates). */
export interface QuickLinkValue extends LinkTemplates {
  name: string;
  tracker: QuickLinkTracker;
}

/**
 * Per-SITE "watch on this site" editor, lived in the popup (the per-site control
 * panel) — independent of recipes, so it works on ANY page of the site. Seeded
 * from the saved link if one exists, else a best-guess derived from the current
 * URL (via `derive`). Self-contained state; no browser APIs.
 */
export function QuickLinkEditor({
  t,
  host,
  initial,
  derive,
  busy,
  onSave,
  onRemove,
}: {
  t: Tokens;
  host: string;
  /** The site's existing quick link, if any (then we're editing, not creating). */
  initial?: QuickLinkValue | null;
  /** Best-guess templates from the current URL for a tracker (fills empty fields). */
  derive?: (tracker: QuickLinkTracker) => LinkTemplates;
  busy?: boolean;
  onSave: (value: QuickLinkValue) => void;
  onRemove?: () => void;
}) {
  const editing = !!initial;
  const seed = initial ?? derive?.("trakt") ?? {};
  // Default to the friendly capitalized hostname ("cineby.at" → "Cineby"), same as
  // a new recipe — not the raw host.
  const [name, setName] = useState(initial?.name ?? defaultRecipeName(host));
  const [tracker, setTracker] = useState<QuickLinkTracker>(initial?.tracker ?? "trakt");
  const [domain, setDomain] = useState(seed.host || linkHost(seed) || host);
  const [movie, setMovie] = useState(seed.movie ?? "");
  const [tv, setTv] = useState(seed.tv ?? "");
  const [anime, setAnime] = useState(seed.anime ?? "");
  const [search, setSearch] = useState(seed.search ?? "");
  const [saved, setSaved] = useState(false);
  const isAniList = tracker === "anilist";

  // Switching tracker fills the target tracker's EMPTY fields from a fresh guess
  // (so you get auto-fill per tracker) without clobbering anything you've typed.
  const switchTracker = (tk: QuickLinkTracker) => {
    setTracker(tk);
    if (editing) return;
    const d = derive?.(tk) ?? {};
    if (tk === "anilist") {
      if (!anime) setAnime(d.anime ?? "");
    } else {
      if (!movie) setMovie(d.movie ?? "");
      if (!tv) setTv(d.tv ?? "");
    }
    if (!search) setSearch(d.search ?? "");
  };

  const save = () => {
    onSave(
      withLinkHost(
        {
          name: name.trim() || defaultRecipeName(host),
          tracker,
          movie: isAniList ? undefined : movie.trim() || undefined,
          tv: isAniList ? undefined : tv.trim() || undefined,
          anime: isAniList ? anime.trim() || undefined : undefined,
          search: search.trim() || undefined,
        },
        domain.trim() || host,
      ),
    );
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const field = (label: string, value: string, set: (v: string) => void, ph: string) => (
    <label class="block">
      <span class={clsx("mb-1 block text-[10px] font-medium", t.faint)}>{label}</span>
      <input
        value={value}
        placeholder={ph}
        onInput={(e) => set((e.target as HTMLInputElement).value)}
        class={clsx(
          "w-full rounded-lg px-2.5 py-1.5 font-mono text-[11px] outline-none ring-inset focus:ring-2",
          t.input,
        )}
      />
    </label>
  );

  return (
    <div class={clsx("space-y-2.5 rounded-xl px-3 py-3", t.card)}>
      {/* shows-on tracker */}
      <div>
        <span class={clsx("mb-1 block text-[10px] font-medium", t.faint)}>Shows on</span>
        <TrackerTab t={t} value={tracker} onChange={switchTracker} />
      </div>

      {field("Name", name, setName, defaultRecipeName(host))}
      {field("Domain", domain, setDomain, host)}
      {isAniList
        ? field("Anime path", anime, setAnime, "/anime/{slug}")
        : [
            field("Movie path", movie, setMovie, "/movie/{tmdb}"),
            field("TV path", tv, setTv, "/tv/{tmdb}/{season}/{episode}"),
          ]}
      {field("Search path", search, setSearch, "/search/{title}")}

      <p class={clsx("text-[10px] leading-snug", t.faint)}>
        Keep the path, swap the dynamic part for a{" "}
        <span
          class="cursor-help underline decoration-dotted underline-offset-2"
          title={placeholderHint(isAniList ? ANILIST_PLACEHOLDERS : TRAKT_PLACEHOLDERS)}
        >
          placeholder
        </span>
        .
      </p>

      <div class="flex items-stretch gap-2">
        <Btn t={t} tone="primary" class="flex-1" disabled={busy} onClick={save}>
          {saved ? "Saved" : editing ? "Update link" : "Save link"}
        </Btn>
        {editing && onRemove && (
          <Btn t={t} tone="danger" title="Remove link" disabled={busy} onClick={onRemove}>
            <Icon name="trash" class="text-[13px]" />
          </Btn>
        )}
      </div>
    </div>
  );
}
