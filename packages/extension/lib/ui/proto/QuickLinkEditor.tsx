import type { Tracker } from "@/lib/tracker/types";
import type { LinkTemplates } from "@tmsync/shared";
import clsx from "clsx";
import { useState } from "preact/hooks";
import { Btn, Icon, type Tokens } from "./kit";

/** A saved quick link's editable shape (per-site "watch on" templates). */
export interface QuickLinkValue extends LinkTemplates {
  name: string;
  tracker: Tracker;
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
  derive?: (tracker: Tracker) => LinkTemplates;
  busy?: boolean;
  onSave: (value: QuickLinkValue) => void;
  onRemove?: () => void;
}) {
  const editing = !!initial;
  const seed = initial ?? derive?.("trakt") ?? {};
  const [name, setName] = useState(initial?.name ?? host);
  const [tracker, setTracker] = useState<Tracker>(initial?.tracker ?? "trakt");
  const [movie, setMovie] = useState(seed.movie ?? "");
  const [tv, setTv] = useState(seed.tv ?? "");
  const [anime, setAnime] = useState(seed.anime ?? "");
  const [search, setSearch] = useState(seed.search ?? "");
  const [saved, setSaved] = useState(false);
  const isAniList = tracker === "anilist";

  // Switching tracker fills the target tracker's EMPTY fields from a fresh guess
  // (so you get auto-fill per tracker) without clobbering anything you've typed.
  const switchTracker = (tk: Tracker) => {
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
    onSave({
      name: name.trim() || host,
      tracker,
      movie: isAniList ? undefined : movie.trim() || undefined,
      tv: isAniList ? undefined : tv.trim() || undefined,
      anime: isAniList ? anime.trim() || undefined : undefined,
      search: search.trim() || undefined,
    });
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
        <div class="flex gap-1">
          {(
            [
              ["trakt", "Trakt"],
              ["anilist", "AniList"],
            ] as const
          ).map(([value, lbl]) => (
            <button
              type="button"
              key={value}
              onClick={() => switchTracker(value)}
              class={clsx(
                "flex-1 rounded-md py-1 text-[11px] font-medium transition-colors",
                tracker === value ? "bg-ikura text-white" : t.ghost,
              )}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {field("Name", name, setName, host)}
      {isAniList
        ? field("Anime URL", anime, setAnime, "https://site/anime/{slug}")
        : [
            field("Movie URL", movie, setMovie, "https://site/movie/{tmdb}"),
            field("TV URL", tv, setTv, "https://site/tv/{tmdb}/{season}/{episode}"),
          ]}
      {field("Search URL", search, setSearch, "https://site/search/{title}")}

      <p class={clsx("text-[10px] leading-snug", t.faint)}>
        Keep the URL, swap the dynamic part for a{" "}
        <span
          class="cursor-help underline decoration-dotted underline-offset-2"
          title={
            isAniList
              ? "Placeholders: {anilistId} {title} {romaji} {slug}"
              : "Placeholders: {tmdb} {imdb} {season} {episode} {title} {slug}"
          }
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
