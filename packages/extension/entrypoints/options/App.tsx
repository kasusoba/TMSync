import { RECIPES } from "@/config";
import type { AniListIdentity } from "@/lib/anilist/types";
import type { AnimapOverrides } from "@/lib/animap/derive";
import { actionError } from "@/lib/errors";
import { requestMalAccess } from "@/lib/mal/access";
import type { MalIdentity } from "@/lib/mal/types";
import { defaultRecipeName } from "@/lib/picker/recipe-builder";
import { applyBackup, buildBackup, parseBackup } from "@/lib/portability/backup";
import { type Contribution, contribute } from "@/lib/portability/contribute";
import { type SiteGroup, groupSites, withSiteHosts, withSiteName } from "@/lib/sites";
import {
  type AnimeMapCache,
  type BadgePrefs,
  type OptionsIntent,
  type QuickLinkSite,
  type RemoteRecipes,
  anilistCorrections,
  animapOverrides,
  animeMap,
  badgePrefs,
  corrections,
  customRecipes,
  malConnectIntent,
  malCorrections,
  newPendingSites,
  optionsIntent,
  quickLinks,
  quickLinksEnabled,
  remoteRecipes,
} from "@/lib/storage";
import { type QuickLinkTracker, type Tracker, trackerLabel } from "@/lib/tracker/types";
import type { ResolvedIdentity } from "@/lib/trakt/types";
import { BadgeModeToggle } from "@/lib/ui/kit/PopupView";
import { TrackerTab } from "@/lib/ui/kit/TrackerTab";
import {
  AniListMark,
  Btn,
  Icon,
  IconBtn,
  type IconName,
  MalMark,
  SimklMark,
  Switch,
  TrackerMark,
  TraktMark,
  tokens,
} from "@/lib/ui/kit/kit";
import {
  type AniListStatus,
  type ProviderStatus,
  type TraktStatus,
  sendMessage,
} from "@/messaging";
import {
  ANILIST_PLACEHOLDERS,
  type PlaceholderDoc,
  type Recipe,
  TRAKT_PLACEHOLDERS,
  hostText,
  isManualRecipe,
  linkHost,
  normalizeHost,
  patternPath,
  recipeHosts,
  recipeTrackers,
  withLinkHost,
} from "@tmsync/shared";
import clsx from "clsx";
import { useEffect, useRef, useState } from "preact/hooks";
import { browser } from "wxt/browser";

const t = tokens("dark");
const host = (origin: string) => origin.replace(/^https?:\/\//, "");

/** A hostname from whatever the user typed: a bare domain, or a pasted URL. Kept
 * as typed (minus case), because it becomes an origin we ask permission for. */
function parseHostInput(value: string): string {
  const bare =
    value
      .trim()
      .replace(/^[a-z]+:\/\//i, "")
      .split(/[/?#]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(bare) ? hostText(bare) : "";
}

/** Hostname a recipe is grouped under: the first host in its scope. */
function recipeHost(r: Recipe): string {
  return recipeHosts(r)[0] ?? r.name;
}

/** Quick-link placeholder reference: each `{token}`, an example, and what it means. */
function PlaceholderHelp({ list, note }: { list: readonly PlaceholderDoc[]; note: string }) {
  return (
    <div class={clsx("space-y-1 text-[11px] leading-relaxed", t.faint)}>
      <p>Placeholders ({note}):</p>
      <ul class="space-y-0.5">
        {list.map((p) => (
          <li key={p.token}>
            <code class="font-mono">{`{${p.token}}`}</code> →{" "}
            <code class="font-mono">{p.example}</code> <span class="opacity-70">{p.desc}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const isShowRecipe = (r: Recipe) =>
  r.mediaType === "show" || !!r.extract?.season || !!r.extract?.episode;

/** What a recipe records, in a word: a manual pick, a show, or a movie. */
const recipeKind = (r: Recipe) =>
  isManualRecipe(r) ? "manual pick" : isShowRecipe(r) ? "show" : "movie";

/** `https://host/segment/` from a recipe: the inferable part of a quick link. */
function recipeBaseUrl(r: Recipe): string {
  const segments = patternPath(r.match.urlPattern).replace(/\\(.)/g, "$1").replace(/^\/+/, "");
  return `https://${recipeHost(r)}/${segments}${segments ? "/" : ""}`;
}

interface RecipeSuggestion {
  host: string;
  name: string;
  movie?: string;
  tv?: string;
}

/** What we CAN infer for a quick link from existing recipes (name + URL base). */
function recipeSuggestions(recipes: Recipe[], links: QuickLinkSite[]): RecipeSuggestion[] {
  const linked = new Set(links.map((l) => normalizeHost(linkHost(l))).filter(Boolean));
  const hasLinkFor = (h: string) => linked.has(normalizeHost(h));
  const byHost = new Map<string, Recipe[]>();
  for (const r of recipes) {
    // Quick-link suggestions are for trakt.tv pages only (we can derive a movie/tv
    // URL base from the recipe), so only recipes that record to Trakt qualify.
    if (!recipeTrackers(r).includes("trakt")) continue;
    const h = recipeHost(r);
    const g = byHost.get(h) ?? [];
    g.push(r);
    byHost.set(h, g);
  }
  const out: RecipeSuggestion[] = [];
  for (const [h, group] of byHost) {
    if (hasLinkFor(h)) continue;
    const movieR = group.find((r) => !isShowRecipe(r));
    const tvR = group.find((r) => isShowRecipe(r));
    out.push({
      host: h,
      name: group[0]?.name ?? h,
      movie: movieR ? recipeBaseUrl(movieR) : undefined,
      tv: tvR ? recipeBaseUrl(tvR) : undefined,
    });
  }
  return out;
}

function PaneHead({ title, right }: { title: string; right?: preact.ComponentChildren }) {
  return (
    <div class="flex items-center justify-between">
      <h2 class={clsx("text-[15px] font-semibold", t.heading)}>{title}</h2>
      {right}
    </div>
  );
}

function Filter({
  q,
  setQ,
  placeholder,
}: { q: string; setQ: (v: string) => void; placeholder: string }) {
  return (
    <div class={clsx("flex items-center gap-2 rounded-lg px-2.5", t.input)}>
      <Icon name="search" class={clsx("text-[14px]", t.faint)} />
      <input
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        placeholder={placeholder}
        class="w-full bg-transparent py-1.5 text-[13px] outline-none"
      />
    </div>
  );
}

/** One editable quick-link site: favourite toggle + drag-reorder + its URL templates. */
function QuickLinkRow({
  site,
  busy,
  open,
  dragging,
  onSave,
  onDelete,
  onToggle,
  onEdit,
  onContribute,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}: {
  site: QuickLinkSite;
  busy: boolean;
  /** Expanded? Owned by the parent so only ONE row is open at a time (accordion). */
  open: boolean;
  /** True while this row is the one being dragged (dimmed). */
  dragging: boolean;
  onSave: (site: QuickLinkSite) => Promise<void>;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  /** Toggle this row's expansion — collapses whichever other row was open. */
  onEdit: () => void;
  /** Open Contribute with this quick link ticked. */
  onContribute: () => void;
  // Drag-to-reorder (HTML5 DnD): handle starts the drag; the row is a drop target.
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(site.name);
  const [tracker, setTracker] = useState<QuickLinkTracker>(site.tracker ?? "trakt");
  const [domain, setDomain] = useState(site.host || linkHost(site));
  const [movie, setMovie] = useState(site.movie ?? "");
  const [tv, setTv] = useState(site.tv ?? "");
  const [anime, setAnime] = useState(site.anime ?? "");
  const [search, setSearch] = useState(site.search ?? "");
  const [saved, setSaved] = useState(false);
  const isAniList = tracker === "anilist";

  const save = async () => {
    const templates = {
      // Keep only the templates that apply to the chosen tracker.
      movie: isAniList ? undefined : movie.trim() || undefined,
      tv: isAniList ? undefined : tv.trim() || undefined,
      anime: isAniList ? anime.trim() || undefined : undefined,
      search: search.trim() || undefined,
    };
    // The domain the user typed, else the one in an absolute template they pasted.
    const finalHost = domain.trim() || linkHost(templates);
    // Like a recipe, default the name to the friendly capitalized hostname. Only
    // when they haven't set their own name.
    const typed = name.trim();
    const fromHost = finalHost ? defaultRecipeName(finalHost) : "";
    const finalName = typed && typed !== "New site" ? typed : fromHost || typed || site.name;
    await onSave(withLinkHost({ ...site, ...templates, name: finalName, tracker }, finalHost));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const field = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <label class="block">
      <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onInput={(e) => set((e.target as HTMLInputElement).value)}
        class={clsx(
          "w-full rounded-lg px-2.5 py-1.5 font-mono text-[11px] outline-none ring-inset focus:ring-2",
          t.input,
        )}
      />
    </label>
  );

  return (
    <div
      ref={rowRef}
      class={clsx("rounded-lg px-3 py-2 transition-opacity", t.card, dragging && "opacity-40")}
      onDragEnter={(e) => {
        e.preventDefault();
        onDragEnter();
      }}
      onDragOver={(e) => e.preventDefault()} // required for the row to be a drop target
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <div class="flex items-center gap-3">
        {/* Drag handle — grab to reorder (HTML5 DnD; the row is the drag image). */}
        <span
          draggable
          title="Drag to reorder"
          class={clsx("-ml-1 shrink-0 cursor-grab touch-none active:cursor-grabbing", t.faint)}
          onDragStart={(e) => {
            e.dataTransfer?.setData("text/plain", site.id); // Firefox needs payload
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            if (rowRef.current) e.dataTransfer?.setDragImage(rowRef.current, 12, 12);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
        >
          <svg viewBox="0 0 24 24" class="size-[15px]" fill="currentColor" aria-hidden="true">
            <circle cx="9" cy="6" r="1.6" />
            <circle cx="15" cy="6" r="1.6" />
            <circle cx="9" cy="12" r="1.6" />
            <circle cx="15" cy="12" r="1.6" />
            <circle cx="9" cy="18" r="1.6" />
            <circle cx="15" cy="18" r="1.6" />
          </svg>
        </span>
        <Switch on={site.enabled} t={t} onClick={() => onToggle(site.id)} />
        {/* tracker indicator — which pages this link shows on */}
        <TrackerMark tracker={site.tracker ?? "trakt"} class="size-4" />
        <span class="min-w-0 flex-1 truncate">
          <span class={clsx("text-[13px] font-medium", t.heading)}>{site.name}</span>
          {site.source === "library" && (
            <span class={clsx("ml-1.5 text-[11px]", t.faint)}>· library</span>
          )}
        </span>
        {site.source !== "library" && (
          <IconBtn t={t} name="external" title="Contribute to library" onClick={onContribute} />
        )}
        <IconBtn t={t} name="edit" title="Edit" onClick={onEdit} />
        <IconBtn t={t} name="trash" title="Delete" danger onClick={() => onDelete(site.id)} />
      </div>
      {open && (
        <div class={clsx("mt-3 space-y-2.5 border-t pt-3", t.divider)}>
          {/* shows on — Trakt pages (movies/TV) or AniList pages (anime) */}
          <div>
            <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Shows on</span>
            <TrackerTab t={t} value={tracker} onChange={setTracker} />
          </div>
          {field("Name", name, setName, "Site name")}
          {field("Domain", domain, setDomain, "site.tld")}
          {isAniList ? (
            <>
              {field("Anime path", anime, setAnime, "/anime/{slug}")}
              {field("Search path", search, setSearch, "/search?q={title}")}
              <PlaceholderHelp list={ANILIST_PLACEHOLDERS} note="shown on anilist.co anime pages" />
            </>
          ) : (
            <>
              {field("Movie path", movie, setMovie, "/movie/{tmdb}")}
              {field("TV path", tv, setTv, "/tv/{tmdb}/{season}/{episode}")}
              {field("Search path", search, setSearch, "/search/{title}")}
              <PlaceholderHelp list={TRAKT_PLACEHOLDERS} note="shown on trakt.tv movie/TV pages" />
            </>
          )}
          <Btn t={t} tone="primary" disabled={busy} onClick={save}>
            {saved ? "Saved" : "Save"}
          </Btn>
        </div>
      )}
    </div>
  );
}

/** One domain of a site: its access dot and, when the site has others, a remove button. */
function HostChip({
  host,
  enabled,
  removable,
  busy,
  onRemove,
}: {
  host: string;
  enabled: boolean;
  removable: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <span
      class={clsx(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px]",
        t.chip,
      )}
    >
      <span
        class={clsx("size-1.5 shrink-0 rounded-full", enabled ? "bg-emerald-500" : "bg-amber-400")}
        title={enabled ? "Allowed" : "Needs access"}
      />
      {host}
      {removable && (
        <IconBtn t={t} name="x" title={`Remove ${host}`} small disabled={busy} onClick={onRemove} />
      )}
    </span>
  );
}

/**
 * One site: its domains and its recipes, in one card. A domain move is done here
 * (add the new domain, remove the old), next to the recipes it changes.
 */
function SiteCard({
  site,
  isHostEnabled,
  allSites,
  busy,
  adding,
  newHost,
  hostNote,
  onEnable,
  onStartAdd,
  onNewHost,
  onAddHost,
  onRemoveHost,
  onRename,
  onContribute,
  onDelete,
}: {
  site: SiteGroup;
  isHostEnabled: (host: string) => boolean;
  /** The broad grant is held: access is on everywhere, so no per-site toggle. */
  allSites: boolean;
  busy: boolean;
  /** The "add a domain" input is open on this card. */
  adding: boolean;
  newHost: string;
  hostNote: string | null;
  onEnable: () => void;
  onStartAdd: () => void;
  onNewHost: (v: string) => void;
  onAddHost: () => void;
  onRemoveHost: (host: string) => void;
  onRename: (name: string) => void;
  /** Open Contribute with this site ticked. */
  onContribute: () => void;
  onDelete: (id: string) => void;
}) {
  const needsAccess = site.hosts.some((h) => !isHostEnabled(h));
  // The site has recipes of your own: you can rename it and contribute it.
  const owned = site.recipes.some((r) => !r.library);
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState(site.name);
  const saveName = () => {
    const name = draftName.trim();
    if (name && name !== site.name) onRename(name);
    setNaming(false);
  };
  return (
    <div class={clsx("space-y-2.5 rounded-lg px-3 py-2.5", t.card)}>
      <div class="flex items-center justify-between gap-3">
        {naming ? (
          <div class="flex min-w-0 flex-1 items-center gap-1.5">
            <input
              value={draftName}
              onInput={(e) => setDraftName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") setNaming(false);
              }}
              class={clsx(
                "min-w-0 flex-1 rounded-lg px-2.5 py-1 text-[13px] outline-none ring-inset focus:ring-2",
                t.input,
              )}
            />
            <Btn t={t} tone="primary" disabled={busy || !draftName.trim()} onClick={saveName}>
              Save
            </Btn>
            <Btn t={t} tone="ghost" onClick={() => setNaming(false)}>
              Cancel
            </Btn>
          </div>
        ) : (
          <span class="flex min-w-0 items-center gap-0.5">
            <span class={clsx("truncate text-[13px] font-semibold", t.heading)}>{site.name}</span>
            {owned && (
              <IconBtn
                t={t}
                name="edit"
                title="Rename site"
                onClick={() => {
                  setDraftName(site.name);
                  setNaming(true);
                }}
              />
            )}
          </span>
        )}
        {!naming && (
          <span class="flex shrink-0 items-center gap-1">
            {owned && (
              <IconBtn
                t={t}
                name="external"
                title="Contribute this site to the library"
                onClick={onContribute}
              />
            )}
            {/* Access is one way: allow once, keep it. The domain dots show the
                state. Removing a domain or the site's last recipe takes it back. */}
            {!allSites && needsAccess && (
              <Btn t={t} tone="primary" disabled={busy} onClick={onEnable}>
                Allow
              </Btn>
            )}
          </span>
        )}
      </div>

      <div>
        <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Domains</span>
        <div class="flex flex-wrap items-center gap-1.5">
          {site.hosts.length === 0 && (
            <span class={clsx("text-[11px]", t.sub)}>Any site with this page shape</span>
          )}
          {site.hosts.map((h) => (
            <HostChip
              key={h}
              host={h}
              enabled={isHostEnabled(h)}
              removable={site.hosts.length > 1}
              busy={busy}
              onRemove={() => onRemoveHost(h)}
            />
          ))}
          {!adding && (
            <IconBtn t={t} name="plus" title="Add a domain (the site moved)" onClick={onStartAdd} />
          )}
        </div>
        {adding && (
          <div class="mt-2 flex items-center gap-1.5">
            <input
              value={newHost}
              placeholder="new-domain.tld"
              spellcheck={false}
              onInput={(e) => onNewHost((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === "Enter" && onAddHost()}
              class={clsx(
                "min-w-0 flex-1 rounded-lg px-2.5 py-1.5 font-mono text-[11px] outline-none ring-inset focus:ring-2",
                t.input,
              )}
            />
            <Btn t={t} tone="primary" disabled={busy || !newHost.trim()} onClick={onAddHost}>
              Add
            </Btn>
            <Btn t={t} tone="ghost" onClick={onStartAdd}>
              Cancel
            </Btn>
          </div>
        )}
        {adding && hostNote && <p class={clsx("mt-1.5 text-[11px]", t.sub)}>{hostNote}</p>}
      </div>

      <div>
        <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Recipes</span>
        <div class="space-y-1">
          {site.recipes.map(({ recipe: r, library }) => (
            <div key={r.id} class="flex items-center justify-between gap-2">
              {/* The card already names the site; a recipe's name shows only when it differs. */}
              <div class="min-w-0">
                <span class="flex items-center gap-1.5">
                  <code class={clsx("truncate font-mono text-[12px]", t.heading)}>
                    {r.match.urlPattern}
                  </code>
                  {recipeTrackers(r).map((tr) => (
                    <span key={tr} title={trackerLabel(tr)}>
                      <TrackerMark tracker={tr} class="size-3.5" />
                    </span>
                  ))}
                </span>
                <span class={clsx("block text-[11px]", t.faint)}>
                  {[recipeKind(r), r.name !== site.name && r.name, library && "library"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              {!library && (
                <div class="flex shrink-0 items-center">
                  <IconBtn
                    t={t}
                    name="trash"
                    title="Delete"
                    danger
                    onClick={() => onDelete(r.id)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** `on`, once it has stayed on for `ms`. */
function useSettled(on: boolean, ms: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!on) {
      setSettled(false);
      return;
    }
    const id = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(id);
  }, [on, ms]);
  return settled;
}

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: "account", label: "Account", icon: "play" },
  { id: "sites", label: "Sites", icon: "frame" },
  { id: "links", label: "Quick links", icon: "link" },
  { id: "corrections", label: "Corrections", icon: "check" },
  { id: "contribute", label: "Contribute", icon: "external" },
  { id: "backup", label: "Backup", icon: "copy" },
  { id: "display", label: "Display", icon: "settings" },
];

/**
 * One provider row in the Account list — uniform across providers (constraint #1:
 * two independent connections, never a sync pair). Always NAMES the provider so
 * "Connect" is never "connect to what?".
 */
function ProviderRow({
  mark,
  name,
  connected,
  busy,
  onConnect,
  onDisconnect,
}: {
  mark: preact.ComponentChildren;
  name: string;
  connected: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div class={clsx("flex items-center gap-3 rounded-lg px-3 py-2.5", t.card)}>
      {mark}
      <span class="min-w-0 flex-1">
        <span class={clsx("block text-[13px] font-semibold", t.heading)}>{name}</span>
        <span class={clsx("flex items-center gap-1.5 text-[11px]", t.sub)}>
          {connected && <span class="size-1.5 rounded-full bg-emerald-500" />}
          {connected ? "Connected" : "Not connected"}
        </span>
      </span>
      {connected ? (
        <Btn t={t} tone="ghost" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Btn>
      ) : (
        <Btn t={t} tone="primary" disabled={busy} onClick={onConnect}>
          Connect
        </Btn>
      )}
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState<TraktStatus | null>(null);
  const [anilist, setAnilist] = useState<AniListStatus | null>(null);
  const [mal, setMal] = useState<ProviderStatus | null>(null);
  const [simkl, setSimkl] = useState<ProviderStatus | null>(null);
  const [sites, setSites] = useState<string[]>([]);
  /** Broad "enable all sites" grant held (then every recipe site is enabled). */
  const [allSites, setAllSites] = useState(false);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [links, setLinks] = useState<QuickLinkSite[]>([]);
  /** Master switch: off hides every quick link, whatever the per-site toggles say. */
  const [linksOn, setLinksOn] = useState(true);
  const [corr, setCorr] = useState<Record<string, ResolvedIdentity>>({});
  // AniList fix-match corrections: the title-keyed pins + the tmdb-keyed crosswalk
  // overrides. Surfaced alongside the Trakt corrections so the pane is the complete
  // fix-match ledger (constraint: every fix the badge can make is visible/clearable).
  const [anilistCorr, setAnilistCorr] = useState<Record<string, AniListIdentity | null>>({});
  const [malCorr, setMalCorr] = useState<Record<string, MalIdentity | null>>({});
  const [animap, setAnimap] = useState<AnimapOverrides>({ forward: {}, reverse: {} });
  const [remote, setRemote] = useState<RemoteRecipes | null>(null);
  /** The CDN anime-map crosswalk cache (multi-track). Shown in the Library pane so
   * "how current is my episode mapping?" is answerable without the devtools. */
  const [mapCache, setMapCache] = useState<AnimeMapCache | null>(null);
  // `working` guards against a second action; `busy` is what the buttons show.
  // Most actions finish in a few milliseconds, and dimming every button for that
  // long reads as a flash, so the busy look waits until an action is slow.
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const busy = useSettled(working, 300);
  const setBusy = (on: boolean) => {
    workingRef.current = on;
    setWorking(on);
  };
  /** The one expanded quick-link row (accordion) — editing another collapses this. */
  const [openLinkId, setOpenLinkId] = useState<string | null>(null);
  /** The single unsaved quick-link draft (from "Add blank"), if any — cleared on save. */
  const [draftId, setDraftId] = useState<string | null>(null);
  const [active, setActive] = useState("account");
  /** The site whose "add a domain" input is open, if any. */
  const [addingHostFor, setAddingHostFor] = useState<string | null>(null);
  const [newHost, setNewHost] = useState("");
  const [hostNote, setHostNote] = useState<string | null>(null);
  const [q, setQ] = useState("");
  /** Sites tab: show only the sites that still need access. */
  const [needsOnly, setNeedsOnly] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  /** Contribute checklist: the rows the user unticked (all are ticked at first). */
  const [skipContrib, setSkipContrib] = useState<Set<string>>(new Set());
  /** After "Contribute": the paste step for a bundle too large to prefill. */
  const [contribNote, setContribNote] = useState<string | null>(null);
  /** Feedback for a Connect attempt (Options mirrors the popup — a failed/cancelled
   * OAuth used to silently do nothing here). */
  const [accountMsg, setAccountMsg] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [badge, setBadge] = useState<BadgePrefs>({ mode: "full", position: null });
  const has = (s: string) => s.toLowerCase().includes(q.toLowerCase());

  const refresh = async () => {
    const [s, al, ml, sk, sit, rec, ql, qlOn, c, ac, mc, am, rem, amap, bp, broad] =
      await Promise.all([
        sendMessage("getTraktStatus", undefined),
        sendMessage("getAniListStatus", undefined),
        sendMessage("getMalStatus", undefined),
        sendMessage("getSimklStatus", undefined),
        sendMessage("listEnabledSites", undefined),
        customRecipes.getValue(),
        quickLinks.getValue(),
        quickLinksEnabled.getValue(),
        corrections.getValue(),
        anilistCorrections.getValue(),
        malCorrections.getValue(),
        animapOverrides.getValue(),
        remoteRecipes.getValue(),
        animeMap.getValue(),
        badgePrefs.getValue(),
        browser.permissions.contains({ origins: ["*://*/*"] }),
      ]);
    setStatus(s);
    setAnilist(al);
    setMal(ml);
    setSimkl(sk);
    setSites(sit);
    setRecipes(rec);
    setLinks(ql);
    setLinksOn(qlOn);
    setCorr(c);
    setAnilistCorr(ac);
    setMalCorr(mc);
    setAnimap(am);
    setRemote(rem);
    setMapCache(amap);
    setBadge(bp);
    setAllSites(broad);
  };

  // Toggle the broad "enable all sites" grant. The request/remove must run in this
  // page's user-gesture context; the SW then reconciles the catch-all vs per-origin
  // scripts. On grant, every recipe (synced/imported/CDN) is live with no prompt.
  const toggleAllSites = () =>
    act(async () => {
      if (allSites) {
        await browser.permissions.remove({ origins: ["*://*/*"] });
      } else if (!(await browser.permissions.request({ origins: ["*://*/*"] }))) {
        return;
      }
      await sendMessage("syncSiteRegistrations", undefined);
    });

  // --- a site's domains ---
  // Streaming sites move domain and keep their pages, so a site's recipes stay
  // right and only the domain list changes. A move is "add the new, remove the old".
  const startAddHost = (key: string) => {
    setAddingHostFor((cur) => (cur === key ? null : key));
    setNewHost("");
    setHostNote(null);
  };

  const addHost = (site: SiteGroup) =>
    act(async () => {
      const to = parseHostInput(newHost);
      if (!to) return setHostNote("That doesn't look like a domain.");
      if (site.hosts.some((h) => normalizeHost(h) === normalizeHost(to))) {
        return setHostNote("This site already has that domain.");
      }
      if (!allSites && !(await browser.permissions.request({ origins: [`https://${to}/*`] }))) {
        return setHostNote("TMSync needs access to the new domain to work there.");
      }
      await customRecipes.setValue(
        withSiteHosts(site, [...site.hosts, to], await customRecipes.getValue()),
      );
      await sendMessage("registerSite", `https://${to}`);
      setAddingHostFor(null);
    });

  // Drop a domain: the recipes stop matching there, its access is revoked, and a
  // quick link that pointed at it follows the site to a domain it still has.
  const removeHost = (site: SiteGroup, gone: string) =>
    act(async () => {
      const isGone = (h: string) => normalizeHost(h) === normalizeHost(gone);
      const rest = site.hosts.filter((h) => !isGone(h));
      const target = rest[0];
      if (!target) return; // the last domain goes with the recipes, not on its own
      await customRecipes.setValue(withSiteHosts(site, rest, await customRecipes.getValue()));
      const ql = await quickLinks.getValue();
      await quickLinks.setValue(ql.map((l) => (isGone(linkHost(l)) ? withLinkHost(l, target) : l)));
      await sendMessage("unregisterSite", `https://${gone}`);
      await browser.permissions.remove({ origins: [`https://${gone}/*`] });
    });

  const renameSite = (site: SiteGroup, name: string) =>
    act(async () => {
      await customRecipes.setValue(withSiteName(site, name, await customRecipes.getValue()));
    });

  // One prompt for every domain of these sites that still needs access. One site
  // from its card, or every visible site from the bulk "Allow" button.
  const allowSites = (groups: SiteGroup[]) =>
    act(async () => {
      const missing = [
        ...new Set(groups.flatMap((g) => g.hosts.map((h) => `https://${h}`))),
      ].filter((o) => !sites.includes(o));
      if (missing.length === 0) return;
      const ok = await browser.permissions.request({ origins: missing.map((o) => `${o}/*`) });
      if (!ok) return;
      for (const origin of missing) await sendMessage("registerSite", origin);
    });

  const toggleLinksOn = async () => {
    const next = !linksOn;
    setLinksOn(next);
    await quickLinksEnabled.setValue(next);
  };

  const updateBadge = async (patch: Partial<BadgePrefs>) => {
    const next = { ...badge, ...patch };
    setBadge(next);
    await badgePrefs.setValue(next);
  };

  // Pull the whole shared library (recipes AND quick links) from the central repo.
  const syncLibrary = async () => {
    setBusy(true);
    setSyncMsg(null);
    const out = await sendMessage("refreshRecipes", undefined);
    setSyncMsg(out.ok ? `Synced · ${out.count} recipes` : `Couldn’t sync: ${out.error}`);
    setRemote(await remoteRecipes.getValue());
    setMapCache(await animeMap.getValue());
    setBusy(false);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on open
  useEffect(() => {
    void refresh();
  }, []);

  // The popup's "Review" asks Options to open on a tab (and filter). Apply it on
  // load, and on a later write if this page is already open. Then clear it.
  useEffect(() => {
    const apply = (intent: OptionsIntent | null) => {
      if (!intent) return;
      setActive(intent.section);
      setQ("");
      setNeedsOnly(!!intent.needsAccess);
      void optionsIntent.setValue(null);
    };
    void optionsIntent.getValue().then(apply);
    return optionsIntent.watch(apply);
  }, []);

  // With Options open, new sites count as seen: the Sites badge in the sidebar
  // shows them on every tab. So the popup nudge is only for sites that arrive
  // while Options is closed (the background library sync, another device, an
  // import from elsewhere).
  useEffect(() => {
    const clear = (list: string[] | null) => {
      if (list && list.length > 0) void newPendingSites.setValue([]);
    };
    void newPendingSites.getValue().then(clear);
    return newPendingSites.watch(clear);
  }, []);

  // A throw must not leave `workingRef` set: every later action would do nothing.
  const act = async (fn: () => Promise<unknown>) => {
    if (workingRef.current) return;
    setBusy(true);
    setActError(null);
    try {
      await fn();
    } catch (e) {
      setActError(actionError(e));
    } finally {
      await refresh().catch(() => {});
      setBusy(false);
    }
  };

  // Connect a provider AND surface the outcome. `act()` discards the reply, so a
  // failed or cancelled OAuth (e.g. the auth window closed, or Trakt rejected the
  // sign-in) showed no feedback in Options — the popup already reports it, so match.
  const connectProvider = async (which: Tracker) => {
    // MAL needs host access first, asked while the click still counts as a gesture.
    // Clear a stale popup intent first, so this grant never starts a second sign-in.
    if (which === "mal") void malConnectIntent.setValue(0);
    if (which === "mal" && !(await requestMalAccess().catch(() => false))) {
      setAccountMsg("MyAnimeList needs access to myanimelist.net to connect.");
      return;
    }
    setBusy(true);
    setAccountMsg(null);
    const message = (
      {
        trakt: "connectTrakt",
        anilist: "connectAniList",
        mal: "connectMal",
        simkl: "connectSimkl",
      } as const
    )[which];
    const res = await sendMessage(message, undefined);
    if (!res.ok) setAccountMsg(res.error ?? "Connection failed. The sign-in didn’t complete.");
    await refresh();
    setBusy(false);
  };

  const disableSite = (origin: string) =>
    act(async () => {
      await sendMessage("unregisterSite", origin);
      await browser.permissions.remove({ origins: [`${origin}/*`] });
    });

  // Delete a recipe. A domain that no recipe covers after this loses its access
  // too: access is one way, so removing the site is how you take it back.
  const deleteRecipe = (id: string) =>
    act(async () => {
      const all = await customRecipes.getValue();
      const gone = all.find((r) => r.id === id);
      const next = all.filter((r) => r.id !== id);
      await customRecipes.setValue(next);
      if (!gone) return;
      const covered = new Set(
        [...next, ...(remote?.recipes ?? [])].flatMap(recipeHosts).map(normalizeHost),
      );
      for (const h of recipeHosts(gone)) {
        if (covered.has(normalizeHost(h))) continue;
        await sendMessage("unregisterSite", `https://${h}`);
        if (!allSites) await browser.permissions.remove({ origins: [`https://${h}/*`] });
      }
    });

  // --- quick links ---
  const saveLink = async (site: QuickLinkSite) => {
    // Upsert: a brand-new (unsaved draft) row isn't in storage yet, so append it;
    // an existing one is replaced. This is what lets "Add" stay a draft until Save.
    const existing = await quickLinks.getValue();
    const next = existing.some((s) => s.id === site.id)
      ? existing.map((s) => (s.id === site.id ? site : s))
      : [...existing, site];
    await quickLinks.setValue(next);
    setLinks(next);
    if (site.id === draftId) setDraftId(null); // draft is now persisted
  };
  const toggleLink = async (id: string) => {
    const next = (await quickLinks.getValue()).map((s) =>
      s.id === id ? { ...s, enabled: !s.enabled } : s,
    );
    await quickLinks.setValue(next);
    setLinks(next);
  };
  const deleteLink = async (id: string) => {
    const next = (await quickLinks.getValue()).filter((s) => s.id !== id);
    await quickLinks.setValue(next);
    setLinks(next);
  };
  // Drag-to-reorder. The list reflows live as you drag (YouTube-style): dragging a
  // row over another moves it there in local state immediately; the new order is
  // persisted once on drop/dragend. `dragIdRef` tracks the dragged id without a
  // stale closure; `linksRef` holds the latest order for the async persist.
  const [dragId, setDragId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const linksRef = useRef(links);
  linksRef.current = links;
  const onLinkDragStart = (id: string) => {
    dragIdRef.current = id;
    setDragId(id);
  };
  const onLinkDragEnter = (overId: string) => {
    const drag = dragIdRef.current;
    if (!drag || drag === overId) return;
    setLinks((cur) => {
      const from = cur.findIndex((s) => s.id === drag);
      const to = cur.findIndex((s) => s.id === overId);
      if (from < 0 || to < 0 || from === to) return cur;
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      if (!moved) return cur;
      next.splice(to, 0, moved);
      return next;
    });
  };
  const onLinkDragEnd = async () => {
    dragIdRef.current = null;
    setDragId(null);
    await quickLinks.setValue(linksRef.current);
  };
  const addLink = () => {
    // Only ONE unsaved draft at a time — if a blank one is still open, don't stack
    // another. A local-only DRAFT: not written to storage until the user hits Save
    // (which upserts it), so bailing out without saving leaves nothing behind.
    if (draftId && links.some((l) => l.id === draftId)) return;
    const id = `ql-${Date.now()}`;
    setLinks((prev) => [...prev, { id, name: "New site", enabled: true }]);
    setDraftId(id);
    setOpenLinkId(id); // auto-expand the new row (and collapse any other)
  };
  const addFromRecipe = async (sg: RecipeSuggestion) => {
    const id = `ql-${Date.now()}`;
    const next = [
      ...(await quickLinks.getValue()),
      withLinkHost({ id, name: sg.name, enabled: true, movie: sg.movie, tv: sg.tv }, sg.host),
    ];
    await quickLinks.setValue(next);
    setLinks(next);
    setOpenLinkId(id); // auto-expand the new row (and collapse any other)
  };

  const exportLetterboxd = async () => {
    setExporting(true);
    setExportNote(null);
    const out = await sendMessage("exportLetterboxd", undefined);
    if (out.ok && out.csv !== undefined) {
      const blob = new Blob([out.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "trakt-letterboxd.csv";
      a.click();
      URL.revokeObjectURL(url);
      const n = out.count ?? 0;
      setExportNote(
        `Exported ${n} ${n === 1 ? "entry" : "entries"}. Import the file at Letterboxd → Settings → Import & Export.`,
      );
    } else {
      setExportNote(`Couldn’t export: ${out.error ?? "unknown error"}`);
    }
    setExporting(false);
  };

  // --- contribute site config to the central repo (prefilled GitHub issue) ---
  const openContribution = async (c: Contribution) => {
    setContribNote(null);
    if (c.paste) {
      // Too long to prefill: copy the JSON, and the issue asks the user to paste it.
      try {
        await navigator.clipboard.writeText(c.json);
        setContribNote("JSON copied. Paste it into the issue.");
      } catch {
        setContribNote("Couldn’t copy the JSON. Use Copy JSON, then paste it into the issue.");
      }
    }
    window.open(c.url, "_blank", "noreferrer");
  };

  // --- backup (export / import the user-owned deltas) ---
  const exportBackup = async () => {
    setBackupBusy(true);
    setBackupNote(null);
    try {
      const backup = await buildBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tmsync-backup-${new Date(backup.exportedAt).toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupNote("Exported your data to a file.");
    } catch {
      setBackupNote("Couldn’t export.");
    }
    setBackupBusy(false);
  };

  const importBackup = async (file: File) => {
    setBackupBusy(true);
    setBackupNote(null);
    try {
      const backup = parseBackup(JSON.parse(await file.text()));
      if (!backup) {
        setBackupNote("That doesn’t look like a TMSync backup file.");
        setBackupBusy(false);
        return;
      }
      const s = await applyBackup(backup);
      // Imported recipes on an already-granted origin (or under the broad grant)
      // should go live now, not on next reload.
      await sendMessage("syncSiteRegistrations", undefined);
      await refresh();
      const parts = [
        `${s.recipes} recipe${s.recipes === 1 ? "" : "s"}`,
        `${s.quickLinks} quick link${s.quickLinks === 1 ? "" : "s"}`,
        `${s.corrections} correction${s.corrections === 1 ? "" : "s"}`,
        `${s.manualSelections} manual pick${s.manualSelections === 1 ? "" : "s"}`,
      ];
      setBackupNote(
        `Imported ${parts.join(", ")}${s.skippedRecipes ? ` · skipped ${s.skippedRecipes} invalid recipe${s.skippedRecipes === 1 ? "" : "s"}` : ""}.`,
      );
    } catch {
      setBackupNote("Couldn’t read that file.");
    }
    setBackupBusy(false);
  };

  const deleteTraktCorrection = (key: string) =>
    act(async () => {
      const next = { ...(await corrections.getValue()) };
      delete next[key];
      await corrections.setValue(next);
      setCorr(next);
    });
  const deleteAnilistTitle = (key: string) =>
    act(async () => {
      const next = { ...(await anilistCorrections.getValue()) };
      delete next[key];
      await anilistCorrections.setValue(next);
      setAnilistCorr(next);
    });
  const deleteMalTitle = (key: string) =>
    act(async () => {
      const next = { ...(await malCorrections.getValue()) };
      delete next[key];
      await malCorrections.setValue(next);
      setMalCorr(next);
    });
  const deleteAnimap = (dir: "forward" | "forwardMal" | "reverse", key: string) =>
    act(async () => {
      const ov = await animapOverrides.getValue();
      const next: AnimapOverrides = {
        forward: { ...ov.forward },
        forwardMal: { ...ov.forwardMal },
        reverse: { ...ov.reverse },
      };
      if (dir === "forward") delete next.forward[key];
      else if (dir === "forwardMal") delete next.forwardMal?.[key];
      else delete next.reverse[Number(key)];
      await animapOverrides.setValue(next);
      setAnimap(next);
    });
  const clearCorrections = () =>
    act(async () => {
      await Promise.all([
        corrections.setValue({}),
        anilistCorrections.setValue({}),
        malCorrections.setValue({}),
        animapOverrides.setValue({ forward: {}, reverse: {} }),
      ]);
      setCorr({});
      setAnilistCorr({});
      setMalCorr({});
      setAnimap({ forward: {}, reverse: {} });
    });

  const connected = status?.connected ?? false;
  // The complete fix-match ledger: Trakt corrections + AniList and MAL title pins + the
  // tmdb-keyed crosswalk overrides. Each row names its tracker so the pane shows
  // every correction the badge can make, regardless of tracker.
  const yr = (y?: number) => (y ? ` (${y})` : "");
  const allCorrections: {
    key: string;
    tracker: Tracker;
    primary: string;
    target: string;
    onDelete: () => void;
  }[] = [
    ...Object.entries(corr).map(([key, id]) => ({
      key: `t:${key}`,
      tracker: "trakt" as Tracker,
      primary: key,
      target: `→ ${id.title}${yr(id.year)} · ${id.mediaType}`,
      onDelete: () => deleteTraktCorrection(key),
    })),
    ...Object.entries(anilistCorr).map(([key, v]) => ({
      key: `a:${key}`,
      tracker: "anilist" as Tracker,
      primary: key,
      target: v ? `→ ${v.title}${yr(v.year)}` : "not on AniList",
      onDelete: () => deleteAnilistTitle(key),
    })),
    ...Object.entries(animap.forward).map(([key, v]) => ({
      key: `af:${key}`,
      tracker: "anilist" as Tracker,
      primary: `tmdb ${key}`,
      target: v == null ? "not on AniList" : `→ AniList #${v}`,
      onDelete: () => deleteAnimap("forward", key),
    })),
    ...Object.entries(malCorr).map(([key, v]) => ({
      key: `m:${key}`,
      tracker: "mal" as Tracker,
      primary: key,
      target: v ? `→ ${v.title}${yr(v.year)}` : "not on MyAnimeList",
      onDelete: () => deleteMalTitle(key),
    })),
    ...Object.entries(animap.forwardMal ?? {}).map(([key, v]) => ({
      key: `mf:${key}`,
      tracker: "mal" as Tracker,
      primary: `tmdb ${key}`,
      target: v == null ? "not on MyAnimeList" : `→ MyAnimeList #${v}`,
      onDelete: () => deleteAnimap("forwardMal", key),
    })),
    ...Object.entries(animap.reverse).map(([key, v]) => ({
      key: `ar:${key}`,
      tracker: "anilist" as Tracker,
      primary: `anilist ${key}`,
      target: `→ tmdb ${v.tmdbId}${v.season != null ? ` S${v.season}` : ""}`,
      onDelete: () => deleteAnimap("reverse", key),
    })),
  ];
  const suggestions = recipeSuggestions(recipes, links);
  const siteGroups = groupSites(recipes, remote?.recipes ?? []);
  const isHostEnabled = (h: string) => allSites || sites.includes(`https://${h}`);
  const siteNeedsAccess = (site: SiteGroup) => site.hosts.some((h) => !isHostEnabled(h));
  // Origins the user enabled that no recipe covers: player iframes, enabled from
  // the popup so a cross-origin player can be tracked.
  const siteHosts = new Set(siteGroups.flatMap((g) => g.hosts.map(normalizeHost)));
  const playerFrames = sites.filter((o) => !siteHosts.has(normalizeHost(host(o)))).sort();
  const notEnabledCount = allSites
    ? 0
    : siteGroups.flatMap((g) => g.hosts).filter((h) => !isHostEnabled(h)).length;
  const siteMatches = (site: SiteGroup) =>
    has(site.name) ||
    site.hosts.some(has) ||
    site.recipes.some(({ recipe }) => has(recipe.name) || has(recipe.match.urlPattern));
  // The "Needs access" count and filter follow the text filter. The filter only
  // applies while a matching site needs access, so it can't leave an empty list
  // after the last one is allowed.
  const matchingSites = siteGroups.filter(siteMatches);
  const toAllow = matchingSites.filter(siteNeedsAccess);
  const needsFilter = needsOnly && toAllow.length > 0;
  const visibleSites = needsFilter ? toAllow : matchingSites;

  // --- contribute: a site is its own recipes plus its quick link ---
  const ownRecipes = (site: SiteGroup) =>
    site.recipes.filter((r) => !r.library).map((r) => r.recipe);
  const ownLinksFor = (site: SiteGroup) => {
    const hosts = new Set(site.hosts.map(normalizeHost));
    return links.filter((l) => l.source !== "library" && hosts.has(normalizeHost(linkHost(l))));
  };
  // Checklist rows: each site of yours, then quick links that belong to none of them.
  const siteRows = siteGroups
    .filter((g) => g.recipes.some((r) => !r.library))
    .map((g) => ({
      key: `site:${g.key}`,
      name: g.name,
      recipes: ownRecipes(g),
      links: ownLinksFor(g),
    }));
  const inSiteRows = new Set(siteRows.flatMap((r) => r.links.map((l) => l.id)));
  const contribRows = [
    ...siteRows,
    ...links
      .filter((l) => l.source !== "library" && !inSiteRows.has(l.id))
      .map((l) => ({ key: `link:${l.id}`, name: l.name, recipes: [] as Recipe[], links: [l] })),
  ];
  const picked = contribRows.filter((r) => !skipContrib.has(r.key));
  const pickedCount = picked.reduce((n, r) => n + r.recipes.length + r.links.length, 0);
  const toggleContrib = (key: string) =>
    setSkipContrib((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // A quick link of one of your sites is contributed with that site.
  const contribKeyOfLink = (l: QuickLinkSite) =>
    siteRows.find((r) => r.links.some((x) => x.id === l.id))?.key ?? `link:${l.id}`;
  // From a Sites or Quick links row: open Contribute with only that row ticked.
  const pickContribution = (key: string) => {
    setSkipContrib(new Set(contribRows.map((r) => r.key).filter((k) => k !== key)));
    setContribNote(null);
    setQ("");
    setActive("contribute");
  };
  const pickedContribution = () =>
    contribute(
      picked.flatMap((r) => r.recipes),
      picked.flatMap((r) => r.links),
      picked.length === 1 ? picked[0]?.name : undefined,
    );
  const copyContribution = async () => {
    try {
      await navigator.clipboard.writeText(pickedContribution().json);
      setCopied("contribution");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setContribNote("Couldn’t copy. The browser blocked the clipboard.");
    }
  };

  const counts: Record<string, number> = {
    links: links.length,
    corrections: allCorrections.length,
  };
  // Sites badge surfaces sites that NEED enabling (an action prompt), not the enabled
  // total — so the user notices a synced/imported recipe waiting for access.
  if (notEnabledCount > 0) counts.sites = notEnabledCount;

  return (
    <div class={clsx("flex min-h-screen flex-col font-sans", t.page)}>
      <header class={clsx("flex items-center gap-3 border-b px-5 py-3.5", t.divider)}>
        <span class={clsx("text-[15px] font-semibold tracking-tight", t.heading)}>TMSync</span>
        <div class="ml-auto flex items-center gap-2.5">
          {syncMsg && <span class={clsx("text-[12px]", t.sub)}>{syncMsg}</span>}
          {contribNote && <span class={clsx("text-[12px]", t.sub)}>{contribNote}</span>}
          <Btn
            t={t}
            tone="ghost"
            disabled={busy}
            onClick={syncLibrary}
            title="Pull the latest recipes and quick links from the shared library"
          >
            <Icon name="refresh" class="text-[12px]" /> Sync library
          </Btn>
        </div>
      </header>

      <div class="flex flex-1">
        <nav class={clsx("flex w-52 shrink-0 flex-col space-y-0.5 border-r p-3", t.divider)}>
          {SECTIONS.map((sec) => (
            <button
              key={sec.id}
              type="button"
              onClick={() => {
                setActive(sec.id);
                setQ("");
              }}
              class={clsx(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                active === sec.id
                  ? clsx(t.card, t.heading, "font-medium")
                  : clsx(t.sub, "hover:bg-white/5"),
              )}
            >
              <Icon name={sec.icon} class="text-[14px]" />
              <span class="flex-1">{sec.label}</span>
              {counts[sec.id] !== undefined && (
                <span
                  class={clsx(
                    "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                    // Sites count = sites awaiting access → an attention tint, not the
                    // neutral chip the other (informational) counts use.
                    sec.id === "sites" ? "bg-amber-500/20 text-amber-300" : t.chip,
                  )}
                >
                  {counts[sec.id]}
                </span>
              )}
            </button>
          ))}
          {/* Which build is running. An unpacked extension is easy to leave stale,
              and a bug report is worth little without the version. */}
          <div class="mt-auto flex items-center justify-between pt-3 pl-2.5">
            <span class={clsx("text-[10px] tabular-nums", t.sub)}>
              v{browser.runtime.getManifest().version}
            </span>
            <IconBtn
              t={t}
              name="github"
              title="TMSync on GitHub"
              onClick={() => window.open(RECIPES.contributeUrl, "_blank", "noreferrer")}
            />
          </div>
        </nav>

        <main class="min-w-0 flex-1 p-6">
          <div class="mx-auto max-w-xl space-y-3">
            {actError && (
              <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>{actError}</p>
            )}
            {active === "account" && (
              <>
                <PaneHead title="Account" />
                {accountMsg && (
                  <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
                    {accountMsg}
                  </p>
                )}
                <ProviderRow
                  mark={<TraktMark />}
                  name="Trakt"
                  connected={connected}
                  busy={busy}
                  onConnect={() => connectProvider("trakt")}
                  onDisconnect={() => act(() => sendMessage("disconnectTrakt", undefined))}
                />
                {/* Dev-only: a forker running their OWN Trakt OAuth app needs to
                    register this redirect URI. The published build uses bundled
                    credentials with a fixed redirect, so end users never see it. */}
                {import.meta.env.DEV && !connected && status?.redirectUri && (
                  <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
                    Set this redirect URI in your Trakt app:
                    <code
                      class={clsx(
                        "mt-1 block break-all rounded-md px-2 py-1 font-mono text-[10px]",
                        t.chip,
                      )}
                    >
                      {status.redirectUri}
                    </code>
                  </p>
                )}
                {connected && (
                  <div class={clsx("space-y-2 rounded-lg px-3 py-2.5", t.card)}>
                    <div class="flex items-center justify-between gap-3">
                      <span class="min-w-0">
                        <span class={clsx("block text-[13px] font-medium", t.heading)}>
                          Export to Letterboxd
                        </span>
                        <span class={clsx("block text-[11px] leading-relaxed", t.sub)}>
                          Your Trakt movie history, ratings &amp; reviews as a Letterboxd-import CSV
                          (rewatches included). Trakt only · AniList isn’t included.
                        </span>
                      </span>
                      <Btn t={t} tone="ghost" disabled={exporting} onClick={exportLetterboxd}>
                        <Icon name="external" class="text-[12px]" />{" "}
                        {exporting ? "Exporting…" : "Export CSV"}
                      </Btn>
                    </div>
                    {exportNote && (
                      <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
                        {exportNote}
                      </p>
                    )}
                  </div>
                )}
                <ProviderRow
                  mark={<AniListMark />}
                  name="AniList"
                  connected={anilist?.connected ?? false}
                  busy={busy}
                  onConnect={() => connectProvider("anilist")}
                  onDisconnect={() => act(() => sendMessage("disconnectAniList", undefined))}
                />
                {anilist && !anilist.configured && (
                  <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
                    AniList isn’t configured in this build · set{" "}
                    <code class="font-mono">WXT_ANILIST_CLIENT_ID</code> and{" "}
                    <code class="font-mono">WXT_ANILIST_CLIENT_SECRET</code> to enable it.
                  </p>
                )}
                {/* Dev-only, same as the Trakt redirect hint above. */}
                {import.meta.env.DEV &&
                  anilist?.configured &&
                  !anilist.connected &&
                  anilist.redirectUri && (
                    <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
                      Set this redirect URI in your AniList app:
                      <code
                        class={clsx(
                          "mt-1 block break-all rounded-md px-2 py-1 font-mono text-[10px]",
                          t.chip,
                        )}
                      >
                        {anilist.redirectUri}
                      </code>
                    </p>
                  )}
                <ProviderRow
                  mark={<MalMark />}
                  name="MyAnimeList"
                  connected={mal?.connected ?? false}
                  busy={busy}
                  onConnect={() => connectProvider("mal")}
                  onDisconnect={() => act(() => sendMessage("disconnectMal", undefined))}
                />
                {mal && !mal.configured && (
                  <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
                    MyAnimeList isn’t configured in this build · set{" "}
                    <code class="font-mono">WXT_MAL_CLIENT_ID</code> to enable it.
                  </p>
                )}
                {/* Dev-only, same as the redirect hints above. */}
                {import.meta.env.DEV && mal?.configured && !mal.connected && mal.redirectUri && (
                  <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
                    Set this redirect URI in your MyAnimeList app:
                    <code
                      class={clsx(
                        "mt-1 block break-all rounded-md px-2 py-1 font-mono text-[10px]",
                        t.chip,
                      )}
                    >
                      {mal.redirectUri}
                    </code>
                  </p>
                )}
                <ProviderRow
                  mark={<SimklMark />}
                  name="Simkl"
                  connected={simkl?.connected ?? false}
                  busy={busy}
                  onConnect={() => connectProvider("simkl")}
                  onDisconnect={() => act(() => sendMessage("disconnectSimkl", undefined))}
                />
                {simkl && !simkl.configured && (
                  <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
                    Simkl isn’t configured in this build · set{" "}
                    <code class="font-mono">WXT_SIMKL_CLIENT_ID</code> to enable it.
                  </p>
                )}
                {/* Dev-only, same as the redirect hints above. */}
                {import.meta.env.DEV &&
                  simkl?.configured &&
                  !simkl.connected &&
                  simkl.redirectUri && (
                    <p class={clsx("text-[11px] leading-relaxed", t.sub)}>
                      Set this redirect URI in your Simkl app:
                      <code
                        class={clsx(
                          "mt-1 block break-all rounded-md px-2 py-1 font-mono text-[10px]",
                          t.chip,
                        )}
                      >
                        {simkl.redirectUri}
                      </code>
                    </p>
                  )}
              </>
            )}

            {active === "sites" && (
              <>
                <PaneHead title="Sites" />
                <p class={clsx("text-[12px] leading-relaxed", t.sub)}>
                  Each site, its domains, and the recipes that read it. Yours win over the shared
                  library where they overlap. If a site moves, add its new domain. Add a site with
                  “Set up this site” in the popup, or{" "}
                  <a
                    href={RECIPES.contributeUrl}
                    target="_blank"
                    rel="noreferrer"
                    class={clsx("underline underline-offset-2", t.link)}
                  >
                    contribute here
                  </a>
                  .
                </p>

                {/* Broad grant: one toggle makes every recipe (synced, imported, or
                    from the library) work instantly, with no per-site prompt. */}
                <div
                  class={clsx(
                    "mb-3 flex items-start justify-between gap-3 rounded-lg px-3 py-2.5",
                    t.card,
                  )}
                >
                  <div class="min-w-0">
                    <div class={clsx("text-[13px] font-medium", t.heading)}>Allow all sites</div>
                    <p class={clsx("mt-0.5 text-[12px]", t.sub)}>
                      New and synced recipes work at once, with no prompt. Turn it off anytime, or
                      allow sites one by one below.
                    </p>
                  </div>
                  <Switch on={allSites} t={t} onClick={() => void toggleAllSites()} />
                </div>

                {siteGroups.length + playerFrames.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    No sites yet. Open the TMSync popup on a streaming site and use “Set up this
                    site”, or import a backup.
                  </p>
                ) : (
                  <Filter q={q} setQ={setQ} placeholder="Filter sites…" />
                )}

                {/* Bulk allow: filter the list, then allow what is visible in one
                    browser prompt. Less than "Allow all sites": a site that a later
                    sync adds still asks first. */}
                {!allSites && toAllow.length > 0 && (
                  <div class="flex items-center justify-between gap-2">
                    <Btn
                      t={t}
                      tone="ghost"
                      class={needsFilter ? "ring-2 ring-ikura" : "ring-1 ring-transparent"}
                      title={needsFilter ? "Show all sites" : "Show only sites that need access"}
                      onClick={() => setNeedsOnly(!needsFilter)}
                    >
                      <span class="size-1.5 rounded-full bg-amber-400" />
                      Needs access · {toAllow.length}
                    </Btn>
                    <Btn
                      t={t}
                      tone="primary"
                      disabled={busy}
                      title={toAllow.map((s) => s.name).join(", ")}
                      onClick={() => void allowSites(toAllow)}
                    >
                      Allow {toAllow.length} site{toAllow.length === 1 ? "" : "s"}
                    </Btn>
                  </div>
                )}

                <div class="space-y-2">
                  {visibleSites.map((site) => (
                    <SiteCard
                      key={site.key}
                      site={site}
                      isHostEnabled={isHostEnabled}
                      allSites={allSites}
                      busy={busy}
                      adding={addingHostFor === site.key}
                      newHost={newHost}
                      hostNote={hostNote}
                      onEnable={() => void allowSites([site])}
                      onStartAdd={() => startAddHost(site.key)}
                      onNewHost={setNewHost}
                      onAddHost={() => void addHost(site)}
                      onRemoveHost={(h) => void removeHost(site, h)}
                      onRename={(name) => void renameSite(site, name)}
                      onContribute={() => pickContribution(`site:${site.key}`)}
                      onDelete={deleteRecipe}
                    />
                  ))}
                </div>

                {/* Origins enabled with no recipe behind them: the player iframes a
                    site embeds, enabled from the popup so playback can be tracked. */}
                {!needsFilter && playerFrames.filter(has).length > 0 && (
                  <>
                    <div class={clsx("flex items-center gap-2 px-1 pt-3 text-[11px]", t.faint)}>
                      <span class="font-medium uppercase tracking-wide">Player frames</span>
                      <span class="h-px flex-1 bg-current opacity-20" />
                      <span>{playerFrames.length}</span>
                    </div>
                    <div class="space-y-1.5">
                      {playerFrames.filter(has).map((origin) => (
                        <div
                          key={origin}
                          class={clsx(
                            "flex items-center justify-between gap-3 rounded-lg px-3 py-2",
                            t.card,
                          )}
                        >
                          <code class={clsx("truncate font-mono text-[12px]", t.heading)}>
                            {host(origin)}
                          </code>
                          {!allSites && (
                            <IconBtn
                              t={t}
                              name="trash"
                              danger
                              title="Remove access"
                              disabled={busy}
                              onClick={() => disableSite(origin)}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* Where the shared recipes and the anime map come from, and how fresh
                    they are. Both ride the same CDN and the same "Sync library". */}
                <div class={clsx("space-y-0.5 px-1 pt-3 text-[11px]", t.faint)}>
                  <p>
                    {remote
                      ? `Library · ${remote.recipes.length} shared recipes · updated ${new Date(remote.fetchedAt).toLocaleString()}`
                      : "Library · not fetched yet · it syncs automatically in the background."}
                  </p>
                  <p>
                    {mapCache
                      ? `Anime map · ${mapCache.rows.length.toLocaleString()} entries${
                          mapCache.generatedAt ? ` · built ${mapCache.generatedAt}` : ""
                        } · updated ${new Date(mapCache.fetchedAt).toLocaleString()}`
                      : "Anime map · not fetched yet · anime multi-tracking waits for it."}
                  </p>
                </div>
              </>
            )}

            {active === "links" && (
              <>
                <PaneHead
                  title="Quick links"
                  right={
                    <div class="flex items-center gap-3">
                      <span class={clsx("flex items-center gap-2 text-[12px]", t.sub)}>
                        {linksOn ? "On" : "Off"}
                        <Switch on={linksOn} t={t} onClick={() => void toggleLinksOn()} />
                      </span>
                      <Btn t={t} tone="ghost" disabled={busy} onClick={addLink}>
                        <Icon name="plus" class="text-[12px]" /> Add blank
                      </Btn>
                    </div>
                  }
                />
                <p class={clsx("text-[12px]", t.sub)}>
                  “Watch on …” buttons added to your trackers’ title pages (Trakt, AniList, and more
                  as trackers are added). Toggle a site on to show it; drag the handle to set
                  display order.
                  {!linksOn &&
                    " Quick links are off, so none of these show until you turn them on."}
                </p>
                {links.length > 3 && <Filter q={q} setQ={setQ} placeholder="Filter quick links…" />}
                {links.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    No quick-link sites yet. Add one and give it the site’s URL patterns.
                  </p>
                ) : (
                  <div class={clsx("space-y-1.5", !linksOn && "opacity-50")}>
                    {links.map((s) =>
                      has(s.name) ? (
                        <QuickLinkRow
                          key={s.id}
                          site={s}
                          busy={busy}
                          open={openLinkId === s.id}
                          dragging={dragId === s.id}
                          onSave={saveLink}
                          onDelete={deleteLink}
                          onToggle={toggleLink}
                          onEdit={() => setOpenLinkId((cur) => (cur === s.id ? null : s.id))}
                          onContribute={() => pickContribution(contribKeyOfLink(s))}
                          onDragStart={() => onLinkDragStart(s.id)}
                          onDragEnter={() => onLinkDragEnter(s.id)}
                          onDragEnd={onLinkDragEnd}
                          onDrop={onLinkDragEnd}
                        />
                      ) : null,
                    )}
                  </div>
                )}
                {suggestions.length > 0 && (
                  <div class={clsx("flex flex-wrap items-center gap-1.5 pt-1 text-[12px]", t.sub)}>
                    <span class="mr-1 shrink-0">From your recipes:</span>
                    {suggestions.map((sg) => (
                      <button
                        key={sg.host}
                        type="button"
                        disabled={busy}
                        onClick={() => addFromRecipe(sg)}
                        class={clsx(
                          "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]",
                          t.ghost,
                        )}
                      >
                        <Icon name="plus" class="text-[10px]" />
                        {sg.host}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {active === "corrections" && (
              <>
                <PaneHead
                  title="Corrections"
                  right={
                    allCorrections.length > 0 ? (
                      <Btn t={t} tone="danger" disabled={busy} onClick={clearCorrections}>
                        Clear all
                      </Btn>
                    ) : undefined
                  }
                />
                {allCorrections.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    No saved corrections. When a match is wrong, click the badge to “fix match” and
                    pick the right entry (Trakt, AniList, or MyAnimeList), and it shows up here.
                  </p>
                ) : (
                  <>
                    {allCorrections.length > 3 && (
                      <Filter q={q} setQ={setQ} placeholder="Filter corrections…" />
                    )}
                    <div class="space-y-1.5">
                      {allCorrections
                        .filter((c) => has(c.primary) || has(c.target))
                        .map((c) => (
                          <div
                            key={c.key}
                            class={clsx(
                              "flex items-center justify-between gap-2 rounded-lg px-3 py-2",
                              t.card,
                            )}
                          >
                            <span class="shrink-0" title={trackerLabel(c.tracker)}>
                              <TrackerMark tracker={c.tracker} class="size-4" />
                            </span>
                            <div class="min-w-0 flex-1">
                              <code class={clsx("block truncate font-mono text-[11px]", t.faint)}>
                                {c.primary}
                              </code>
                              <span class={clsx("block truncate text-[12px]", t.heading)}>
                                {c.target}
                              </span>
                            </div>
                            <IconBtn
                              t={t}
                              name="trash"
                              title="Remove"
                              danger
                              disabled={busy}
                              onClick={c.onDelete}
                            />
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </>
            )}

            {active === "contribute" && (
              <>
                <PaneHead title="Contribute" />
                <p class={clsx("text-[12px] leading-relaxed", t.sub)}>
                  Share your recipes &amp; quick links with everyone. This opens a GitHub issue with
                  them filled in: site config only, no watch data. A maintainer checks it, then it
                  goes into the shared library. Tick what to share, then open an issue, or copy the
                  JSON to paste it yourself.
                </p>
                {contribRows.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    Nothing to share yet. Recipes and quick links you make show here.
                  </p>
                ) : (
                  <>
                    {/* One row per site (its recipes and its quick link) or loose
                        quick link. All ticked at first: untick what to keep back. */}
                    <div class="space-y-1.5">
                      {contribRows.map((row) => (
                        <label
                          key={row.key}
                          class={clsx(
                            "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2",
                            t.card,
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={!skipContrib.has(row.key)}
                            onChange={() => toggleContrib(row.key)}
                            class="size-4 shrink-0 cursor-pointer accent-ikura"
                          />
                          <span class="min-w-0 flex-1">
                            <span class={clsx("block truncate text-[13px]", t.heading)}>
                              {row.name}
                            </span>
                            <span class={clsx("block text-[11px]", t.sub)}>
                              {[
                                row.recipes.length > 0 &&
                                  `${row.recipes.length} recipe${row.recipes.length === 1 ? "" : "s"}`,
                                row.links.length > 0 &&
                                  `${row.links.length} quick link${row.links.length === 1 ? "" : "s"}`,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                    <div class="flex items-center justify-between gap-2">
                      <Btn
                        t={t}
                        tone="ghost"
                        onClick={() =>
                          setSkipContrib(
                            picked.length === contribRows.length
                              ? new Set(contribRows.map((r) => r.key))
                              : new Set(),
                          )
                        }
                      >
                        {picked.length === contribRows.length ? "Select none" : "Select all"}
                      </Btn>
                      <span class="flex items-center gap-2">
                        <Btn
                          t={t}
                          tone="ghost"
                          disabled={pickedCount === 0}
                          onClick={() => void copyContribution()}
                        >
                          <Icon
                            name={copied === "contribution" ? "check" : "copy"}
                            class="text-[12px]"
                          />
                          {copied === "contribution" ? "Copied" : "Copy JSON"}
                        </Btn>
                        <Btn
                          t={t}
                          tone="primary"
                          disabled={pickedCount === 0}
                          onClick={() => void openContribution(pickedContribution())}
                        >
                          <Icon name="external" class="text-[12px]" /> Open issue · {pickedCount}
                        </Btn>
                      </span>
                    </div>
                  </>
                )}
              </>
            )}

            {active === "backup" && (
              <>
                <PaneHead title="Backup &amp; restore" />
                <p class={clsx("text-[12px] leading-relaxed", t.sub)}>
                  Save your TMSync data · custom recipes, your quick links, corrections and manual
                  picks · to a file, and import it on another device. Your tracker logins and caches
                  aren’t included.
                </p>
                <div class={clsx("flex items-center gap-3 rounded-lg px-3 py-2.5", t.card)}>
                  <span class="min-w-0 flex-1">
                    <span class={clsx("block text-[13px] font-medium", t.heading)}>
                      Export to file
                    </span>
                    <span class={clsx("block text-[11px]", t.sub)}>
                      Downloads a JSON backup of your data.
                    </span>
                  </span>
                  <Btn t={t} tone="ghost" disabled={backupBusy} onClick={exportBackup}>
                    <Icon name="external" class="text-[12px]" /> Export
                  </Btn>
                </div>
                <div class={clsx("flex items-center gap-3 rounded-lg px-3 py-2.5", t.card)}>
                  <span class="min-w-0 flex-1">
                    <span class={clsx("block text-[13px] font-medium", t.heading)}>
                      Import from file
                    </span>
                    <span class={clsx("block text-[11px]", t.sub)}>
                      Merges a backup into this device · your items win, nothing is deleted.
                    </span>
                  </span>
                  <Btn
                    t={t}
                    tone="ghost"
                    disabled={backupBusy}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Icon name="copy" class="text-[12px]" /> Import
                  </Btn>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  class="hidden"
                  onChange={(e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    if (f) void importBackup(f);
                    (e.target as HTMLInputElement).value = "";
                  }}
                />
                {backupNote && (
                  <p class={clsx("rounded-lg px-3 py-2 text-[12px]", t.infoBox)}>{backupNote}</p>
                )}
              </>
            )}

            {active === "display" && (
              <>
                <PaneHead title="Display" />
                <p class={clsx("mb-3 text-[12px] leading-relaxed", t.sub)}>
                  The toolbar icon always shows scrobble status, and the popup mirrors it. The
                  on-page badge is optional · hide it or move it off your player’s controls.
                </p>

                <div class="flex items-center justify-between">
                  <span class={clsx("text-[11px] font-medium", t.faint)}>On-page badge</span>
                  <BadgeModeToggle
                    t={t}
                    mode={badge.mode}
                    onMode={(mode) => updateBadge({ mode })}
                  />
                </div>
                <p class={clsx("mt-2 text-[12px] leading-relaxed", t.sub)}>
                  Drag the badge to move it (grab the status bar, or the dot) · it snaps to the
                  nearest screen edge.
                </p>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
