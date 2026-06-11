import { RECIPES } from "@/config";
import {
  type BadgePrefs,
  type QuickLinkSite,
  type RemoteRecipes,
  badgePrefs,
  corrections,
  customRecipes,
  quickLinks,
  remoteRecipes,
} from "@/lib/storage";
import type { Tracker } from "@/lib/tracker/types";
import type { ResolvedIdentity } from "@/lib/trakt/types";
import {
  AniListMark,
  Btn,
  Icon,
  IconBtn,
  type IconName,
  Switch,
  TraktMark,
  tokens,
} from "@/lib/ui/proto/kit";
import { type AniListStatus, type TraktStatus, sendMessage } from "@/messaging";
import type { Recipe } from "@tmsync/shared";
import clsx from "clsx";
import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";

const t = tokens("dark");
const host = (origin: string) => origin.replace(/^https?:\/\//, "");

/** Hostname a recipe belongs to (for grouping): the hint, else from the urlPattern. */
function recipeHost(r: Recipe): string {
  if (r.match.hostnames?.[0]) return r.match.hostnames[0];
  const unescaped = r.match.urlPattern.replace(/\\(.)/g, "$1");
  return unescaped.split("/")[0] || r.name;
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

/** One editable quick-link site: favourite toggle + reorder + its URL templates. */
function QuickLinkRow({
  site,
  busy,
  first,
  last,
  startOpen,
  onSave,
  onDelete,
  onToggle,
  onMove,
}: {
  site: QuickLinkSite;
  busy: boolean;
  first: boolean;
  last: boolean;
  startOpen: boolean;
  onSave: (site: QuickLinkSite) => Promise<void>;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState(site.name);
  const [tracker, setTracker] = useState<Tracker>(site.tracker ?? "trakt");
  const [movie, setMovie] = useState(site.movie ?? "");
  const [tv, setTv] = useState(site.tv ?? "");
  const [anime, setAnime] = useState(site.anime ?? "");
  const [search, setSearch] = useState(site.search ?? "");
  const [saved, setSaved] = useState(false);
  const isAniList = tracker === "anilist";

  const save = async () => {
    await onSave({
      ...site,
      name: name.trim() || site.name,
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
    <div class={clsx("rounded-lg px-3 py-2", t.card)}>
      <div class="flex items-center gap-3">
        <Switch on={site.enabled} t={t} onClick={() => onToggle(site.id)} />
        {/* tracker indicator — which pages this link shows on */}
        {(site.tracker ?? "trakt") === "anilist" ? (
          <AniListMark class="size-4" />
        ) : (
          <TraktMark class="size-4" />
        )}
        <span class="min-w-0 flex-1 truncate">
          <span class={clsx("text-[13px] font-medium", t.heading)}>{site.name}</span>
          {site.source === "library" && (
            <span class={clsx("ml-1.5 text-[11px]", t.faint)}>· library</span>
          )}
        </span>
        <IconBtn t={t} name="up" title="Move up" onClick={() => !first && onMove(site.id, -1)} />
        <IconBtn t={t} name="down" title="Move down" onClick={() => !last && onMove(site.id, 1)} />
        <IconBtn t={t} name="edit" title="Edit" onClick={() => setOpen((v) => !v)} />
        <IconBtn t={t} name="trash" title="Delete" danger onClick={() => onDelete(site.id)} />
      </div>
      {open && (
        <div class={clsx("mt-3 space-y-2.5 border-t pt-3", t.divider)}>
          {/* shows on — Trakt pages (movies/TV) or AniList pages (anime) */}
          <div>
            <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Shows on</span>
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
                  onClick={() => setTracker(value)}
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
          {field("Name", name, setName, "Site name")}
          {isAniList ? (
            <>
              {field("Anime URL", anime, setAnime, "https://site/anime/{slug}")}
              {field("Search URL", search, setSearch, "https://site/search?q={title}")}
              <p class={clsx("text-[11px] leading-relaxed", t.faint)}>
                Placeholders: {"{anilistId} {title} {romaji} {slug}"} — shown on anilist.co anime
                pages.
              </p>
            </>
          ) : (
            <>
              {field("Movie URL", movie, setMovie, "https://site/movie/{tmdb}")}
              {field("TV URL", tv, setTv, "https://site/tv/{tmdb}/{season}/{episode}")}
              {field("Search URL", search, setSearch, "https://site/search/{title}")}
              <p class={clsx("text-[11px] leading-relaxed", t.faint)}>
                Placeholders: {"{tmdb} {imdb} {season} {episode} {title} {slug}"} (year-free),{" "}
                {"{slugyear}"} (with year).
              </p>
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
  { id: "library", label: "Library", icon: "refresh" },
  { id: "recipes", label: "Your recipes", icon: "edit" },
  { id: "corrections", label: "Corrections", icon: "check" },
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
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [links, setLinks] = useState<QuickLinkSite[]>([]);
  const [corr, setCorr] = useState<Record<string, ResolvedIdentity>>({});
  const [remote, setRemote] = useState<RemoteRecipes | null>(null);
  const [recipeNote, setRecipeNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [active, setActive] = useState("account");
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [badge, setBadge] = useState<BadgePrefs>({ mode: "full", position: "bottom-left" });
  const has = (s: string) => s.toLowerCase().includes(q.toLowerCase());

  const refresh = async () => {
    const [s, al, sit, rec, ql, c, rem, bp] = await Promise.all([
      sendMessage("getTraktStatus", undefined),
      sendMessage("getAniListStatus", undefined),
      sendMessage("listEnabledSites", undefined),
      customRecipes.getValue(),
      quickLinks.getValue(),
      corrections.getValue(),
      remoteRecipes.getValue(),
      badgePrefs.getValue(),
    ]);
    setStatus(s);
    setAnilist(al);
    setSites(sit);
    setRecipes(rec);
    setLinks(ql);
    setCorr(c);
    setRemote(rem);
    setBadge(bp);
  };

  const updateBadge = async (patch: Partial<BadgePrefs>) => {
    const next = { ...badge, ...patch };
    setBadge(next);
    await badgePrefs.setValue(next);
  };

  const refreshRecipes = async () => {
    setBusy(true);
    setRecipeNote(null);
    const out = await sendMessage("refreshRecipes", undefined);
    setRecipeNote(out.ok ? `Synced — ${out.count} recipes.` : `Couldn’t sync: ${out.error}`);
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

  // --- quick links ---
  const saveLink = async (site: QuickLinkSite) => {
    const next = (await quickLinks.getValue()).map((s) => (s.id === site.id ? site : s));
    await quickLinks.setValue(next);
    setLinks(next);
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
  const moveLink = async (id: string, dir: -1 | 1) => {
    const next = [...(await quickLinks.getValue())];
    const i = next.findIndex((s) => s.id === id);
    const j = i + dir;
    const a = next[i];
    const b = next[j];
    if (!a || !b) return;
    next[i] = b;
    next[j] = a;
    await quickLinks.setValue(next);
    setLinks(next);
  };
  const addLink = async () => {
    const id = `ql-${Date.now()}`;
    const next = [...(await quickLinks.getValue()), { id, name: "New site", enabled: true }];
    await quickLinks.setValue(next);
    setLinks(next);
    setJustAdded(id);
  };
  const addFromRecipe = async (sg: RecipeSuggestion) => {
    const id = `ql-${Date.now()}`;
    const next = [
      ...(await quickLinks.getValue()),
      { id, name: sg.name, enabled: true, movie: sg.movie, tv: sg.tv },
    ];
    await quickLinks.setValue(next);
    setLinks(next);
    setJustAdded(id);
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

  const deleteCorrection = (key: string) =>
    act(async () => {
      const next = { ...(await corrections.getValue()) };
      delete next[key];
      await corrections.setValue(next);
      setCorr(next);
    });
  const clearCorrections = () =>
    act(async () => {
      await corrections.setValue({});
      setCorr({});
    });

  const connected = status?.connected ?? false;
  const corrEntries = Object.entries(corr);
  const suggestions = recipeSuggestions(recipes, links);
  const recipeGroups = new Map<string, Recipe[]>();
  for (const r of recipes) {
    const key = recipeHost(r);
    (recipeGroups.get(key) ?? recipeGroups.set(key, []).get(key))?.push(r);
  }
  const counts: Record<string, number> = {
    sites: sites.length,
    links: links.length,
    library: remote?.recipes.length ?? 0,
    recipes: recipes.length,
    corrections: corrEntries.length,
  };

  return (
    <div class={clsx("flex min-h-screen flex-col font-sans", t.page)}>
      <header class={clsx("flex items-center border-b px-5 py-3.5", t.divider)}>
        <span class={clsx("text-[15px] font-semibold tracking-tight", t.heading)}>TMSync</span>
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
                <span class={clsx("rounded-full px-1.5 py-0.5 text-[10px] tabular-nums", t.chip)}>
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
                <p class={clsx("text-[12px]", t.sub)}>
                  Two independent trackers. Movies &amp; non-anime TV route to Trakt; anime series
                  to AniList — one item to one tracker, never both.
                </p>
                <ProviderRow
                  mark={<TraktMark />}
                  name="Trakt"
                  connected={connected}
                  busy={busy}
                  onConnect={() => act(() => sendMessage("connectTrakt", undefined))}
                  onDisconnect={() => act(() => sendMessage("disconnectTrakt", undefined))}
                />
                {!connected && status?.redirectUri && (
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
                <ProviderRow
                  mark={<AniListMark />}
                  name="AniList"
                  connected={anilist?.connected ?? false}
                  busy={busy}
                  onConnect={() => act(() => sendMessage("connectAniList", undefined))}
                  onDisconnect={() => act(() => sendMessage("disconnectAniList", undefined))}
                />
                {anilist && !anilist.configured && (
                  <p class={clsx("rounded-md px-2.5 py-1.5 text-[11px]", t.infoBox)}>
                    AniList isn’t configured in this build — set{" "}
                    <code class="font-mono">WXT_ANILIST_CLIENT_ID</code> and{" "}
                    <code class="font-mono">WXT_ANILIST_CLIENT_SECRET</code> to enable it.
                  </p>
                )}
                {anilist?.configured && !anilist.connected && anilist.redirectUri && (
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
                {connected && (
                  <div class={clsx("space-y-2 rounded-lg px-3 py-2.5", t.card)}>
                    <div class="flex items-center justify-between gap-3">
                      <span class="min-w-0">
                        <span class={clsx("block text-[13px] font-medium", t.heading)}>
                          Export to Letterboxd
                        </span>
                        <span class={clsx("block text-[11px] leading-relaxed", t.sub)}>
                          Your movie history, ratings &amp; reviews as a Letterboxd-import CSV
                          (rewatches included).
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
              </>
            )}

            {active === "sites" && (
              <>
                <PaneHead title="Enabled sites" />
                {sites.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    No sites enabled yet. Open the TMSync popup on a streaming site to enable it.
                  </p>
                ) : (
                  <>
                    <Filter q={q} setQ={setQ} placeholder="Filter sites…" />
                    <div class="space-y-1.5">
                      {sites.filter(has).map((origin) => (
                        <div
                          key={origin}
                          class={clsx(
                            "flex items-center justify-between gap-3 rounded-lg px-3 py-2",
                            t.card,
                          )}
                        >
                          <code
                            class={clsx("truncate font-mono text-[12px]", t.heading)}
                            title={origin}
                          >
                            {host(origin)}
                          </code>
                          <Btn
                            t={t}
                            tone="ghost"
                            disabled={busy}
                            onClick={() => disableSite(origin)}
                          >
                            Disable
                          </Btn>
                        </div>
                      ))}
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
                    <Btn t={t} tone="ghost" disabled={busy} onClick={addLink}>
                      <Icon name="plus" class="text-[12px]" /> Add blank
                    </Btn>
                  }
                />
                <p class={clsx("text-[12px]", t.sub)}>
                  “Watch on …” buttons on Trakt movie/show pages. Toggle a site on to show it; order
                  = display order.
                </p>
                {links.length > 3 && <Filter q={q} setQ={setQ} placeholder="Filter quick links…" />}
                {links.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    No quick-link sites yet. Add one and give it the site’s URL patterns.
                  </p>
                ) : (
                  <div class="space-y-1.5">
                    {links.map((s, i) =>
                      has(s.name) ? (
                        <QuickLinkRow
                          key={s.id}
                          site={s}
                          busy={busy}
                          first={i === 0}
                          last={i === links.length - 1}
                          startOpen={s.id === justAdded}
                          onSave={saveLink}
                          onDelete={deleteLink}
                          onToggle={toggleLink}
                          onMove={moveLink}
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

            {active === "library" && (
              <>
                <PaneHead
                  title="Recipe library"
                  right={
                    <Btn t={t} tone="ghost" disabled={busy} onClick={refreshRecipes}>
                      <Icon name="refresh" class="text-[12px]" /> Refresh
                    </Btn>
                  }
                />
                <p class={clsx("text-[12px]", t.sub)}>
                  {remote
                    ? `${remote.recipes.length} recipe${remote.recipes.length === 1 ? "" : "s"} · updated ${new Date(remote.fetchedAt).toLocaleString()}`
                    : "Not fetched yet — it syncs automatically in the background."}
                </p>
                {remote && remote.recipes.length > 3 && (
                  <Filter q={q} setQ={setQ} placeholder="Filter library…" />
                )}
                <div class="space-y-1.5">
                  {remote?.recipes
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
                <p class={clsx("text-[11px] leading-relaxed", t.faint)}>
                  Shared through the project repo (no server) and merged with your own (yours win).
                  Add a site by opening a PR —{" "}
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
                {recipeNote && (
                  <p class={clsx("rounded-lg px-3 py-2 text-[12px]", t.infoBox)}>{recipeNote}</p>
                )}
              </>
            )}

            {active === "recipes" && (
              <>
                <PaneHead title="Your recipes" />
                {recipes.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    No custom recipes. Use “Set up this site” in the popup to author one.
                  </p>
                ) : (
                  <>
                    {recipes.length > 3 && (
                      <Filter q={q} setQ={setQ} placeholder="Filter recipes…" />
                    )}
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
                  </>
                )}
              </>
            )}

            {active === "corrections" && (
              <>
                <PaneHead
                  title="Corrections"
                  right={
                    corrEntries.length > 0 ? (
                      <Btn t={t} tone="danger" disabled={busy} onClick={clearCorrections}>
                        Clear all
                      </Btn>
                    ) : undefined
                  }
                />
                {corrEntries.length === 0 ? (
                  <p class={clsx("rounded-lg px-3 py-4 text-center text-[12px]", t.card, t.sub)}>
                    No saved corrections. When a match is wrong, click the badge to pick the right
                    title.
                  </p>
                ) : (
                  <>
                    {corrEntries.length > 3 && (
                      <Filter q={q} setQ={setQ} placeholder="Filter corrections…" />
                    )}
                    <div class="space-y-1.5">
                      {corrEntries
                        .filter(([key, id]) => has(key) || has(id.title))
                        .map(([key, id]) => (
                          <div
                            key={key}
                            class={clsx(
                              "flex items-center justify-between gap-2 rounded-lg px-3 py-2",
                              t.card,
                            )}
                          >
                            <div class="min-w-0">
                              <code class={clsx("block truncate font-mono text-[11px]", t.faint)}>
                                {key}
                              </code>
                              <span class={clsx("text-[12px]", t.heading)}>
                                → {id.title}
                                {id.year ? ` (${id.year})` : ""} · {id.mediaType}
                              </span>
                            </div>
                            <IconBtn
                              t={t}
                              name="trash"
                              title="Remove"
                              danger
                              disabled={busy}
                              onClick={() => deleteCorrection(key)}
                            />
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </>
            )}

            {active === "display" && (
              <>
                <PaneHead title="Display" />
                <p class={clsx("mb-3 text-[12px] leading-relaxed", t.sub)}>
                  The toolbar icon always shows scrobble status, and the popup mirrors it. The
                  on-page badge is optional — hide it or move it off your player’s controls.
                </p>

                <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>
                  On-page badge
                </span>
                <div class="mb-4 flex gap-1">
                  {(
                    [
                      ["full", "Full"],
                      ["dot", "Dot only"],
                      ["off", "Off"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      onClick={() => updateBadge({ mode: value })}
                      class={clsx(
                        "flex-1 rounded-md py-1.5 text-[12px] font-medium transition-colors",
                        badge.mode === value ? "bg-ikura text-white" : t.ghost,
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>Position</span>
                <div class="grid max-w-[260px] grid-cols-2 gap-1">
                  {(
                    [
                      ["top-left", "Top left"],
                      ["top-right", "Top right"],
                      ["bottom-left", "Bottom left"],
                      ["bottom-right", "Bottom right"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      disabled={badge.mode === "off"}
                      onClick={() => updateBadge({ position: value })}
                      class={clsx(
                        "rounded-md py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40",
                        badge.position === value ? "bg-ikura text-white" : t.ghost,
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
