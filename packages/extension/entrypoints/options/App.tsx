import { RECIPES } from "@/config";
import type { AniListIdentity } from "@/lib/anilist/types";
import type { AnimapOverrides } from "@/lib/animap/derive";
import { defaultRecipeName } from "@/lib/picker/recipe-builder";
import { applyBackup, buildBackup, parseBackup } from "@/lib/portability/backup";
import {
  type Contribution,
  blankIssueUrl,
  contributeAll,
  contributeQuickLink,
  contributeRecipe,
} from "@/lib/portability/contribute";
import {
  type BadgePrefs,
  type QuickLinkSite,
  type RemoteRecipes,
  anilistCorrections,
  animapOverrides,
  badgePrefs,
  corrections,
  customRecipes,
  quickLinks,
  remoteRecipes,
} from "@/lib/storage";
import { type Tracker, trackerLabel } from "@/lib/tracker/types";
import type { ResolvedIdentity } from "@/lib/trakt/types";
import { BadgeModeToggle } from "@/lib/ui/kit/PopupView";
import { TrackerTab } from "@/lib/ui/kit/TrackerTab";
import {
  AniListMark,
  Btn,
  Icon,
  IconBtn,
  type IconName,
  Switch,
  TrackerMark,
  TraktMark,
  tokens,
} from "@/lib/ui/kit/kit";
import { type AniListStatus, type TraktStatus, sendMessage } from "@/messaging";
import {
  ANILIST_PLACEHOLDERS,
  type PlaceholderDoc,
  type Recipe,
  TRAKT_PLACEHOLDERS,
} from "@tmsync/shared";
import clsx from "clsx";
import { useEffect, useRef, useState } from "preact/hooks";
import { browser } from "wxt/browser";

const t = tokens("dark");
const host = (origin: string) => origin.replace(/^https?:\/\//, "");

/** Hostname a recipe belongs to (for grouping): the hint, else from the urlPattern. */
function recipeHost(r: Recipe): string {
  if (r.match.hostnames?.[0]) return r.match.hostnames[0];
  const unescaped = r.match.urlPattern.replace(/\\(.)/g, "$1");
  return unescaped.split("/")[0] || r.name;
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

/** `https://host/segment/` from a recipe's urlPattern — the inferable part of a link. */
function recipeBaseUrl(r: Recipe): string {
  const unescaped = r.match.urlPattern.replace(/\\(.)/g, "$1");
  const [h, ...rest] = unescaped.split("/");
  const segments = rest.join("/");
  return `https://${h}/${segments}${segments ? "/" : ""}`;
}

interface RecipeSuggestion {
  host: string;
  name: string;
  movie?: string;
  tv?: string;
}

/** What we CAN infer for a quick link from existing recipes (name + URL base). */
function recipeSuggestions(recipes: Recipe[], links: QuickLinkSite[]): RecipeSuggestion[] {
  const hasLinkFor = (h: string) =>
    links.some((l) => [l.movie, l.tv, l.search].some((u) => u?.includes(h)));
  const byHost = new Map<string, Recipe[]>();
  for (const r of recipes) {
    // Quick-link suggestions are Trakt-only (we can derive a movie/tv URL base
    // from the recipe). Anime recipes don't map to an anilist.co anime-site URL.
    if ((r.tracker ?? "trakt") === "anilist") continue;
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
  onCopy,
  copied,
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
  /** Show the "Copied!" tick on the copy button. */
  copied: boolean;
  /** True while this row is the one being dragged (dimmed). */
  dragging: boolean;
  onSave: (site: QuickLinkSite) => Promise<void>;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  /** Toggle this row's expansion — collapses whichever other row was open. */
  onEdit: () => void;
  /** Copy this quick link's JSON to the clipboard (mirrors the recipe copy). */
  onCopy: () => void;
  onContribute: () => void;
  // Drag-to-reorder (HTML5 DnD): handle starts the drag; the row is a drop target.
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(site.name);
  const [tracker, setTracker] = useState<Tracker>(site.tracker ?? "trakt");
  const [movie, setMovie] = useState(site.movie ?? "");
  const [tv, setTv] = useState(site.tv ?? "");
  const [anime, setAnime] = useState(site.anime ?? "");
  const [search, setSearch] = useState(site.search ?? "");
  const [saved, setSaved] = useState(false);
  const isAniList = tracker === "anilist";

  const save = async () => {
    // Like a recipe, default the name to the friendly capitalized hostname — but a
    // quick link added here has no page context, so derive it from the first URL
    // template the user typed. Only when they haven't set their own name.
    const typed = name.trim();
    const fromUrl = [movie, tv, anime, search].reduce<string>((acc, u) => {
      if (acc || !u) return acc;
      try {
        return defaultRecipeName(new URL(u).hostname);
      } catch {
        return acc;
      }
    }, "");
    const finalName = typed && typed !== "New site" ? typed : fromUrl || typed || site.name;
    await onSave({
      ...site,
      name: finalName,
      tracker,
      // Keep only the templates that apply to the chosen tracker.
      movie: isAniList ? undefined : movie.trim() || undefined,
      tv: isAniList ? undefined : tv.trim() || undefined,
      anime: isAniList ? anime.trim() || undefined : undefined,
      search: search.trim() || undefined,
    });
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
        <IconBtn
          t={t}
          name={copied ? "check" : "copy"}
          title={copied ? "Copied!" : "Copy JSON"}
          onClick={onCopy}
        />
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
          {isAniList ? (
            <>
              {field("Anime URL", anime, setAnime, "https://site/anime/{slug}")}
              {field("Search URL", search, setSearch, "https://site/search?q={title}")}
              <PlaceholderHelp list={ANILIST_PLACEHOLDERS} note="shown on anilist.co anime pages" />
            </>
          ) : (
            <>
              {field("Movie URL", movie, setMovie, "https://site/movie/{tmdb}")}
              {field("TV URL", tv, setTv, "https://site/tv/{tmdb}/{season}/{episode}")}
              {field("Search URL", search, setSearch, "https://site/search/{title}")}
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

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: "account", label: "Account", icon: "play" },
  { id: "sites", label: "Sites", icon: "frame" },
  { id: "links", label: "Quick links", icon: "link" },
  { id: "recipes", label: "Recipes", icon: "edit" },
  { id: "corrections", label: "Corrections", icon: "check" },
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
  const [sites, setSites] = useState<string[]>([]);
  /** Broad "enable all sites" grant held (then every recipe site is enabled). */
  const [allSites, setAllSites] = useState(false);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [links, setLinks] = useState<QuickLinkSite[]>([]);
  const [corr, setCorr] = useState<Record<string, ResolvedIdentity>>({});
  // AniList fix-match corrections: the title-keyed pins + the tmdb-keyed crosswalk
  // overrides. Surfaced alongside the Trakt corrections so the pane is the complete
  // fix-match ledger (constraint: every fix the badge can make is visible/clearable).
  const [anilistCorr, setAnilistCorr] = useState<Record<string, AniListIdentity | null>>({});
  const [animap, setAnimap] = useState<AnimapOverrides>({ forward: {}, reverse: {} });
  const [remote, setRemote] = useState<RemoteRecipes | null>(null);
  const [busy, setBusy] = useState(false);
  /** The one expanded quick-link row (accordion) — editing another collapses this. */
  const [openLinkId, setOpenLinkId] = useState<string | null>(null);
  /** The single unsaved quick-link draft (from "Add blank"), if any — cleared on save. */
  const [draftId, setDraftId] = useState<string | null>(null);
  const [active, setActive] = useState("account");
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  /** Feedback for a Connect attempt (Options mirrors the popup — a failed/cancelled
   * OAuth used to silently do nothing here). */
  const [accountMsg, setAccountMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [badge, setBadge] = useState<BadgePrefs>({ mode: "full", position: null });
  const has = (s: string) => s.toLowerCase().includes(q.toLowerCase());

  const refresh = async () => {
    const [s, al, sit, rec, ql, c, ac, am, rem, bp, broad] = await Promise.all([
      sendMessage("getTraktStatus", undefined),
      sendMessage("getAniListStatus", undefined),
      sendMessage("listEnabledSites", undefined),
      customRecipes.getValue(),
      quickLinks.getValue(),
      corrections.getValue(),
      anilistCorrections.getValue(),
      animapOverrides.getValue(),
      remoteRecipes.getValue(),
      badgePrefs.getValue(),
      browser.permissions.contains({ origins: ["*://*/*"] }),
    ]);
    setStatus(s);
    setAnilist(al);
    setSites(sit);
    setRecipes(rec);
    setLinks(ql);
    setCorr(c);
    setAnilistCorr(ac);
    setAnimap(am);
    setRemote(rem);
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

  // Grant a single recipe's origin from the "needs enabling" list.
  const enablePending = (origin: string) =>
    act(async () => {
      if (!(await browser.permissions.request({ origins: [`${origin}/*`] }))) return;
      await sendMessage("registerSite", origin);
    });

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
    setBusy(false);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on open
  useEffect(() => {
    void refresh();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    await refresh();
    setBusy(false);
  };

  // Connect a provider AND surface the outcome. `act()` discards the reply, so a
  // failed or cancelled OAuth (e.g. the auth window closed, or Trakt rejected the
  // sign-in) showed no feedback in Options — the popup already reports it, so match.
  const connectProvider = async (which: "trakt" | "anilist") => {
    setBusy(true);
    setAccountMsg(null);
    const res = await sendMessage(which === "trakt" ? "connectTrakt" : "connectAniList", undefined);
    if (!res.ok) setAccountMsg(res.error ?? "Connection failed. The sign-in didn’t complete.");
    await refresh();
    setBusy(false);
  };

  const disableSite = (origin: string) =>
    act(async () => {
      await sendMessage("unregisterSite", origin);
      await browser.permissions.remove({ origins: [`${origin}/*`] });
    });

  const deleteRecipe = async (id: string) => {
    const next = (await customRecipes.getValue()).filter((r) => r.id !== id);
    await customRecipes.setValue(next);
    setRecipes(next);
  };
  const copyRecipe = async (r: Recipe) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
      setCopied(r.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard blocked — ignore
    }
  };
  const copyLink = async (s: QuickLinkSite) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(s, null, 2));
      setCopied(s.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard blocked — ignore
    }
  };

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
      { id, name: sg.name, enabled: true, movie: sg.movie, tv: sg.tv },
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
    if (c.tooLong) {
      // Too long to prefill — copy the payload and open a blank issue to paste it.
      try {
        await navigator.clipboard.writeText(c.json);
      } catch {
        // clipboard blocked — ignore; the user can still file manually
      }
      window.open(blankIssueUrl, "_blank", "noreferrer");
    } else {
      window.open(c.url, "_blank", "noreferrer");
    }
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
  const deleteAnimap = (dir: "forward" | "reverse", key: string) =>
    act(async () => {
      const ov = await animapOverrides.getValue();
      const next: AnimapOverrides = { forward: { ...ov.forward }, reverse: { ...ov.reverse } };
      if (dir === "forward") delete next.forward[key];
      else delete next.reverse[Number(key)];
      await animapOverrides.setValue(next);
      setAnimap(next);
    });
  const clearCorrections = () =>
    act(async () => {
      await Promise.all([
        corrections.setValue({}),
        anilistCorrections.setValue({}),
        animapOverrides.setValue({ forward: {}, reverse: {} }),
      ]);
      setCorr({});
      setAnilistCorr({});
      setAnimap({ forward: {}, reverse: {} });
    });

  const connected = status?.connected ?? false;
  // The complete fix-match ledger: Trakt corrections + AniList title pins + the
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
    ...Object.entries(animap.reverse).map(([key, v]) => ({
      key: `ar:${key}`,
      tracker: "anilist" as Tracker,
      primary: `anilist ${key}`,
      target: `→ tmdb ${v.tmdbId}${v.season != null ? ` S${v.season}` : ""}`,
      onDelete: () => deleteAnimap("reverse", key),
    })),
  ];
  const suggestions = recipeSuggestions(recipes, links);
  const recipeGroups = new Map<string, Recipe[]>();
  for (const r of recipes) {
    const key = recipeHost(r);
    (recipeGroups.get(key) ?? recipeGroups.set(key, []).get(key))?.push(r);
  }
  // Every site TMSync knows about = origins the user granted + each recipe's host
  // (custom + library). Under the broad grant they're ALL enabled even if
  // `enabledOrigins` (sites) is empty — that's the fix for "works but shows disabled".
  const recipeOrigins = [
    ...new Set(
      [...recipes, ...(remote?.recipes ?? [])]
        .map((r) => r.match.hostnames?.[0])
        .filter((h): h is string => !!h)
        .map((h) => `https://${h}`),
    ),
  ];
  const knownOrigins = [...new Set([...sites, ...recipeOrigins])].sort();
  const isSiteEnabled = (o: string) => allSites || sites.includes(o);
  const notEnabledCount = allSites ? 0 : knownOrigins.filter((o) => !sites.includes(o)).length;

  const counts: Record<string, number> = {
    links: links.length,
    recipes: recipes.length + (remote?.recipes.length ?? 0),
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
        <nav class={clsx("w-52 shrink-0 space-y-0.5 border-r p-3", t.divider)}>
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
        </nav>

        <main class="min-w-0 flex-1 p-6">
          <div class="mx-auto max-w-xl space-y-3">
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
              </>
            )}

            {active === "sites" && (
              <>
                <PaneHead title="Sites" />

                {/* Broad grant: one toggle makes every recipe (synced, imported, or
                    from the library) work instantly, with no per-site prompt. */}
                <div
                  class={clsx(
                    "mb-3 flex items-start justify-between gap-3 rounded-lg px-3 py-2.5",
                    t.card,
                  )}
                >
                  <div class="min-w-0">
                    <div class={clsx("text-[13px] font-medium", t.heading)}>Enable all sites</div>
                    <p class={clsx("mt-0.5 text-[12px]", t.sub)}>
                      Grant access to every site so new and synced recipes work instantly. You can
                      revoke access anytime, or enable sites one by one below.
                    </p>
                  </div>
                  <Switch on={allSites} t={t} onClick={() => void toggleAllSites()} />
                </div>

                {/* One list of every site TMSync knows — granted origins AND each
                    recipe's host — each with an enabled/needs-access indicator. Under
                    the broad grant they all read "Enabled" (the catch-all covers them),
                    which is the fix for an imported site working but showing nothing. */}
                {knownOrigins.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    No sites yet. Import or add a recipe, or open the TMSync popup on a streaming
                    site to enable it.
                  </p>
                ) : (
                  <>
                    <Filter q={q} setQ={setQ} placeholder="Filter sites…" />
                    <div class="space-y-1.5">
                      {knownOrigins.filter(has).map((origin) => {
                        const enabled = isSiteEnabled(origin);
                        return (
                          <div
                            key={origin}
                            class={clsx(
                              "flex items-center justify-between gap-3 rounded-lg px-3 py-2",
                              t.card,
                            )}
                          >
                            <span class="flex min-w-0 items-center gap-2">
                              <span
                                class={clsx(
                                  "size-1.5 shrink-0 rounded-full",
                                  enabled ? "bg-emerald-500" : "bg-amber-400",
                                )}
                                title={enabled ? "Enabled" : "Needs access"}
                              />
                              <code
                                class={clsx("truncate font-mono text-[12px]", t.heading)}
                                title={origin}
                              >
                                {host(origin)}
                              </code>
                            </span>
                            {allSites ? (
                              <span class={clsx("shrink-0 text-[11px]", t.sub)}>Enabled</span>
                            ) : enabled ? (
                              <Btn
                                t={t}
                                tone="ghost"
                                disabled={busy}
                                onClick={() => disableSite(origin)}
                              >
                                Disable
                              </Btn>
                            ) : (
                              <Btn
                                t={t}
                                tone="primary"
                                disabled={busy}
                                onClick={() => void enablePending(origin)}
                              >
                                Enable
                              </Btn>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}

            {active === "links" && (
              <>
                <PaneHead
                  title="Quick links"
                  right={
                    <div class="flex gap-1.5">
                      {links.length > 0 && (
                        <Btn
                          t={t}
                          tone="ghost"
                          disabled={busy}
                          onClick={() => openContribution(contributeAll([], links))}
                        >
                          <Icon name="external" class="text-[12px]" /> Contribute all
                        </Btn>
                      )}
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
                </p>
                {links.length > 3 && <Filter q={q} setQ={setQ} placeholder="Filter quick links…" />}
                {links.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    No quick-link sites yet. Add one and give it the site’s URL patterns.
                  </p>
                ) : (
                  <div class="space-y-1.5">
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
                          onCopy={() => copyLink(s)}
                          copied={copied === s.id}
                          onContribute={() => openContribution(contributeQuickLink(s))}
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

            {active === "recipes" && (
              <>
                <PaneHead
                  title="Recipes"
                  right={
                    recipes.length > 0 && (
                      <Btn
                        t={t}
                        tone="ghost"
                        disabled={busy}
                        onClick={() => openContribution(contributeAll(recipes, []))}
                      >
                        <Icon name="external" class="text-[12px]" /> Contribute all
                      </Btn>
                    )
                  }
                />
                <p class={clsx("text-[12px] leading-relaxed", t.sub)}>
                  Your own recipes and the shared library, together. Yours win where they overlap.
                  Add a site with “Set up this site” in the popup, or{" "}
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
                {recipes.length + (remote?.recipes.length ?? 0) > 3 && (
                  <Filter q={q} setQ={setQ} placeholder="Filter recipes…" />
                )}

                {/* Your recipes (editable) */}
                <div class={clsx("flex items-center gap-2 px-1 pt-1 text-[11px]", t.faint)}>
                  <span class="font-medium uppercase tracking-wide">Yours</span>
                  <span class="h-px flex-1 bg-current opacity-20" />
                  <span>{recipes.length}</span>
                </div>
                {recipes.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-3 text-center text-[12px]", t.card, t.sub)}>
                    No custom recipes yet. Use “Set up this site” in the popup to author one.
                  </p>
                ) : (
                  <div class="space-y-3">
                    {[...recipeGroups.entries()].map(([hostname, group]) => {
                      const items = group.filter(
                        (r) => has(r.name) || has(r.match.urlPattern) || has(hostname),
                      );
                      if (items.length === 0) return null;
                      return (
                        <div key={hostname}>
                          <div
                            class={clsx(
                              "mb-1.5 flex items-center justify-between px-1 text-[11px]",
                              t.faint,
                            )}
                          >
                            <code class="font-mono">{hostname}</code>
                            <span>
                              {items.length} recipe{items.length > 1 ? "s" : ""}
                            </span>
                          </div>
                          <div class="space-y-1.5">
                            {items.map((r) => (
                              <div
                                key={r.id}
                                class={clsx(
                                  "flex items-center justify-between gap-2 rounded-lg px-3 py-2",
                                  t.card,
                                )}
                              >
                                <div class="min-w-0">
                                  <span class={clsx("block text-[13px] font-medium", t.heading)}>
                                    {r.name}
                                  </span>
                                  <code
                                    class={clsx("block truncate font-mono text-[11px]", t.faint)}
                                  >
                                    {r.match.urlPattern}
                                  </code>
                                </div>
                                <div class="flex shrink-0 items-center">
                                  <IconBtn
                                    t={t}
                                    name="external"
                                    title="Contribute to library"
                                    onClick={() => openContribution(contributeRecipe(r))}
                                  />
                                  <IconBtn
                                    t={t}
                                    name={copied === r.id ? "check" : "copy"}
                                    title={copied === r.id ? "Copied!" : "Copy JSON"}
                                    onClick={() => copyRecipe(r)}
                                  />
                                  <IconBtn
                                    t={t}
                                    name="trash"
                                    title="Delete"
                                    danger
                                    onClick={() => deleteRecipe(r.id)}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Library (read-only, from the repo) */}
                <div class={clsx("flex items-center gap-2 px-1 pt-3 text-[11px]", t.faint)}>
                  <span class="font-medium uppercase tracking-wide">Library</span>
                  <span class="h-px flex-1 bg-current opacity-20" />
                  <span>{remote?.recipes.length ?? 0}</span>
                </div>
                <p class={clsx("px-1 text-[11px]", t.faint)}>
                  {remote
                    ? `Shared via the repo · updated ${new Date(remote.fetchedAt).toLocaleString()}`
                    : "Not fetched yet · it syncs automatically in the background."}
                </p>
                {remote && remote.recipes.length > 0 ? (
                  <div class="space-y-1.5">
                    {remote.recipes
                      .filter((r) => has(r.name) || has(r.match.urlPattern))
                      .map((r) => (
                        <div class={clsx("rounded-lg px-3 py-2", t.card)} key={r.id}>
                          <span class={clsx("block text-[13px] font-medium", t.heading)}>
                            {r.name}
                          </span>
                          <code class={clsx("block truncate font-mono text-[11px]", t.faint)}>
                            {r.match.urlPattern}
                          </code>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p class={clsx("rounded-lg px-3 py-3 text-center text-[12px]", t.card, t.sub)}>
                    The shared library is empty · contribute a site to seed it.
                  </p>
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
                    pick the right entry — Trakt or AniList — and it shows up here.
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

                <PaneHead title="Contribute" />
                <p class={clsx("text-[12px] leading-relaxed", t.sub)}>
                  Share your recipes &amp; quick links with everyone by opening a prefilled GitHub
                  issue · no watch data is included, only site config. (You can also contribute a
                  single entry from its row.)
                </p>
                <div class={clsx("flex items-center gap-3 rounded-lg px-3 py-2.5", t.card)}>
                  <span class="min-w-0 flex-1">
                    <span class={clsx("block text-[13px] font-medium", t.heading)}>
                      Contribute everything
                    </span>
                    <span class={clsx("block text-[11px]", t.sub)}>
                      {recipes.length} recipe{recipes.length === 1 ? "" : "s"} ·{" "}
                      {links.filter((l) => l.source !== "library").length} quick link
                      {links.filter((l) => l.source !== "library").length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <Btn
                    t={t}
                    tone="ghost"
                    disabled={
                      recipes.length === 0 &&
                      links.filter((l) => l.source !== "library").length === 0
                    }
                    onClick={() => openContribution(contributeAll(recipes, links))}
                  >
                    <Icon name="external" class="text-[12px]" /> Contribute all
                  </Btn>
                </div>
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
