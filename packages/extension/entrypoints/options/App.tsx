import { RECIPES } from "@/config";
import {
  type QuickLinkSite,
  type RemoteRecipes,
  corrections,
  customRecipes,
  quickLinks,
  remoteRecipes,
} from "@/lib/storage";
import type { ResolvedIdentity } from "@/lib/trakt/types";
import { type TraktStatus, sendMessage } from "@/messaging";
import type { Recipe } from "@tmsync/shared";
import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";

const host = (origin: string) => origin.replace(/^https?:\/\//, "");

/** Hostname a recipe belongs to (for grouping): the hint, else from the urlPattern. */
function recipeHost(r: Recipe): string {
  if (r.match.hostnames?.[0]) return r.match.hostnames[0];
  const unescaped = r.match.urlPattern.replace(/\\(.)/g, "$1");
  return unescaped.split("/")[0] || r.name;
}

const isShowRecipe = (r: Recipe) =>
  r.mediaType === "show" || !!r.extract.season || !!r.extract.episode;

/** `https://host/segment/` from a recipe's urlPattern — the inferable part of a link. */
function recipeBaseUrl(r: Recipe): string {
  const unescaped = r.match.urlPattern.replace(/\\(.)/g, "$1");
  const [host, ...rest] = unescaped.split("/");
  const segments = rest.join("/");
  return `https://${host}/${segments}${segments ? "/" : ""}`;
}

interface RecipeSuggestion {
  host: string;
  name: string;
  movie?: string;
  tv?: string;
}

/**
 * What we CAN infer for a quick link from existing recipes: the site name and
 * the URL base (host + path prefix). The id/slug tail is left for the user —
 * recipes don't know how a site maps to Trakt's tmdb/imdb. Hosts that already
 * have a quick link are skipped.
 */
function recipeSuggestions(recipes: Recipe[], links: QuickLinkSite[]): RecipeSuggestion[] {
  const hasLinkFor = (host: string) =>
    links.some((l) => [l.movie, l.tv, l.search].some((u) => u?.includes(host)));
  const byHost = new Map<string, Recipe[]>();
  for (const r of recipes) {
    const h = recipeHost(r);
    const g = byHost.get(h) ?? [];
    g.push(r);
    byHost.set(h, g);
  }
  const out: RecipeSuggestion[] = [];
  for (const [host, group] of byHost) {
    if (hasLinkFor(host)) continue;
    const movieR = group.find((r) => !isShowRecipe(r));
    const tvR = group.find((r) => isShowRecipe(r));
    out.push({
      host,
      name: group[0]?.name ?? host,
      movie: movieR ? recipeBaseUrl(movieR) : undefined,
      tv: tvR ? recipeBaseUrl(tvR) : undefined,
    });
  }
  return out;
}

/** Trakt connect/disconnect — mirrors the popup, lives here for a stable home. */
function TraktSection({
  status,
  busy,
  onChange,
}: {
  status: TraktStatus | null;
  busy: boolean;
  onChange: () => void | Promise<void>;
}) {
  const connected = status?.connected ?? false;
  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    await onChange();
  };
  return (
    <section>
      <h2>Trakt</h2>
      <div class="row">
        <span class={connected ? "ok" : "muted"}>{connected ? "Connected" : "Not connected"}</span>
        {connected ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => sendMessage("disconnectTrakt", undefined))}
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => sendMessage("connectTrakt", undefined))}
          >
            Connect Trakt
          </button>
        )}
      </div>
      {!connected && status?.redirectUri && (
        <p class="hint">
          Register this redirect URI in your Trakt app:
          <code>{status.redirectUri}</code>
        </p>
      )}
    </section>
  );
}

function EnabledSites({
  sites,
  busy,
  onDisable,
}: {
  sites: string[];
  busy: boolean;
  onDisable: (origin: string) => void;
}) {
  return (
    <section>
      <h2>Enabled sites</h2>
      {sites.length === 0 ? (
        <p class="muted">
          No sites enabled yet. Open the TMSync popup on a streaming site to enable it.
        </p>
      ) : (
        sites.map((origin) => (
          <div class="row" key={origin}>
            <code title={origin}>{host(origin)}</code>
            <button type="button" disabled={busy} onClick={() => onDisable(origin)}>
              Disable
            </button>
          </div>
        ))
      )}
    </section>
  );
}

/** One editable quick-link site: a favourite toggle + its URL templates. */
function QuickLinkRow({
  site,
  busy,
  onSave,
  onDelete,
  onToggle,
  startOpen,
}: {
  site: QuickLinkSite;
  busy: boolean;
  onSave: (site: QuickLinkSite) => Promise<void>;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState(site.name);
  const [movie, setMovie] = useState(site.movie ?? "");
  const [tv, setTv] = useState(site.tv ?? "");
  const [search, setSearch] = useState(site.search ?? "");
  const [saved, setSaved] = useState(false);

  const save = async () => {
    await onSave({
      ...site,
      name: name.trim() || site.name,
      movie: movie.trim() || undefined,
      tv: tv.trim() || undefined,
      search: search.trim() || undefined,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div class="card">
      <div class="row">
        <label class="grow toggle" title="Show on Trakt pages">
          <input
            type="checkbox"
            checked={site.enabled}
            disabled={busy}
            onChange={() => onToggle(site.id)}
          />
          <strong>{site.name}</strong>
        </label>
        <button type="button" class="link" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Edit"}
        </button>
        <button type="button" class="link danger" onClick={() => onDelete(site.id)}>
          Delete
        </button>
      </div>
      {open && (
        <div class="linkform">
          <label>
            Name
            <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            Movie URL
            <input
              value={movie}
              onInput={(e) => setMovie((e.target as HTMLInputElement).value)}
              placeholder="https://site/movie/{tmdb}"
            />
          </label>
          <label>
            TV URL (show→S1E1, season→S{"{n}"}E1, episode→S{"{n}"}E{"{m}"})
            <input
              value={tv}
              onInput={(e) => setTv((e.target as HTMLInputElement).value)}
              placeholder="https://site/tv/{tmdb}/{season}/{episode}"
            />
          </label>
          <label>
            Search URL
            <input
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
              placeholder="https://site/search/{slug}"
            />
          </label>
          <p class="hint">
            Placeholders: <code>{"{tmdb}"}</code> <code>{"{imdb}"}</code> <code>{"{season}"}</code>{" "}
            <code>{"{episode}"}</code> <code>{"{title}"}</code> <code>{"{slug}"}</code> (year-free){" "}
            <code>{"{slugyear}"}</code> (with year).
          </p>
          <button type="button" onClick={save}>
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}

function QuickLinks({
  sites,
  suggestions,
  busy,
  onSave,
  onDelete,
  onToggle,
  onAdd,
  onAddFromRecipe,
  justAdded,
}: {
  sites: QuickLinkSite[];
  suggestions: RecipeSuggestion[];
  busy: boolean;
  onSave: (site: QuickLinkSite) => Promise<void>;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  onAdd: () => void;
  onAddFromRecipe: (s: RecipeSuggestion) => void;
  justAdded: string | null;
}) {
  return (
    <section>
      <div class="row">
        <h2>Quick links</h2>
        <button type="button" class="link" disabled={busy} onClick={onAdd}>
          + Add blank
        </button>
      </div>
      <p class="hint">
        “Watch on …” buttons added to Trakt movie/show pages. Toggle a site on to show it — keep it
        to your favourites.
      </p>
      {suggestions.length > 0 && (
        <p class="hint">
          From your recipes (name + URL base pre-filled; add the id/slug):{" "}
          {suggestions.map((s) => (
            <button
              type="button"
              class="link"
              key={s.host}
              disabled={busy}
              onClick={() => onAddFromRecipe(s)}
            >
              + {s.host}
            </button>
          ))}
        </p>
      )}
      {sites.length === 0 ? (
        <p class="muted">No quick-link sites yet. Add one and give it the site’s URL patterns.</p>
      ) : (
        sites.map((s) => (
          <QuickLinkRow
            key={s.id}
            site={s}
            busy={busy}
            onSave={onSave}
            onDelete={onDelete}
            onToggle={onToggle}
            startOpen={s.id === justAdded}
          />
        ))
      )}
    </section>
  );
}

function RecipeLibrary({
  remote,
  busy,
  note,
  onRefresh,
}: {
  remote: RemoteRecipes | null;
  busy: boolean;
  note: string | null;
  onRefresh: () => void;
}) {
  return (
    <section>
      <div class="row">
        <h2>Recipe library</h2>
        <button type="button" class="link" disabled={busy} onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <p class="muted">
        {remote
          ? `${remote.recipes.length} recipe${remote.recipes.length === 1 ? "" : "s"} from the library · updated ${new Date(remote.fetchedAt).toLocaleString()}`
          : "Not fetched yet — it syncs automatically in the background."}
      </p>
      {remote?.recipes.map((r) => (
        <div class="card" key={r.id}>
          <strong>{r.name}</strong>
          <code class="block">{r.match.urlPattern}</code>
        </div>
      ))}
      <p class="hint">
        Recipes are shared through the project repo (no server) and merge with your own (yours win).
        Add a site by opening a PR —{" "}
        <a href={RECIPES.contributeUrl} target="_blank" rel="noreferrer">
          contribute here
        </a>{" "}
        using a recipe’s “Copy JSON”.
      </p>
      {note && <p class="note">{note}</p>}
    </section>
  );
}

function CustomRecipes({
  recipes,
  onDelete,
}: {
  recipes: Recipe[];
  onDelete: (id: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (r: Recipe) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
      setCopied(r.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard blocked — ignore
    }
  };

  // Group by hostname — a single site often has several recipes (movie, tv, …).
  const groups = new Map<string, Recipe[]>();
  for (const r of recipes) {
    const key = recipeHost(r);
    (groups.get(key) ?? groups.set(key, []).get(key))?.push(r);
  }

  return (
    <section>
      <h2>Your recipes</h2>
      {recipes.length === 0 ? (
        <p class="muted">
          No custom recipes. Use “Set it up with the picker” in the popup to author one.
        </p>
      ) : (
        [...groups.entries()].map(([hostname, group]) => (
          <div class="group" key={hostname}>
            <div class="grouphead">
              <code>{hostname}</code>
              <span class="muted">
                {group.length} recipe{group.length > 1 ? "s" : ""}
              </span>
            </div>
            {group.map((r) => (
              <div class="card" key={r.id}>
                <div class="row">
                  <div class="grow">
                    <strong>{r.name}</strong>
                    <code class="block">{r.match.urlPattern}</code>
                  </div>
                </div>
                <div class="actions">
                  <button type="button" class="link" onClick={() => copy(r)}>
                    {copied === r.id ? "Copied JSON" : "Copy JSON"}
                  </button>
                  <button type="button" class="link danger" onClick={() => onDelete(r.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </section>
  );
}

function Corrections({
  entries,
  busy,
  onDelete,
  onClear,
}: {
  entries: [string, ResolvedIdentity][];
  busy: boolean;
  onDelete: (key: string) => void;
  onClear: () => void;
}) {
  return (
    <section>
      <div class="row">
        <h2>Corrections</h2>
        {entries.length > 0 && (
          <button type="button" class="link danger" disabled={busy} onClick={onClear}>
            Clear all
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p class="muted">
          No saved corrections. When a match is wrong, click the badge to pick the right title.
        </p>
      ) : (
        entries.map(([key, id]) => (
          <div class="card" key={key}>
            <div class="row">
              <div class="grow">
                <code class="block">{key}</code>
                <span>
                  → {id.title}
                  {id.year ? ` (${id.year})` : ""} · {id.mediaType}
                </span>
              </div>
              <button
                type="button"
                class="link danger"
                disabled={busy}
                onClick={() => onDelete(key)}
              >
                Remove
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

export function App() {
  const [status, setStatus] = useState<TraktStatus | null>(null);
  const [sites, setSites] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [links, setLinks] = useState<QuickLinkSite[]>([]);
  const [corr, setCorr] = useState<Record<string, ResolvedIdentity>>({});
  const [remote, setRemote] = useState<RemoteRecipes | null>(null);
  const [recipeNote, setRecipeNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const refresh = async () => {
    const [s, sit, rec, ql, c, rem] = await Promise.all([
      sendMessage("getTraktStatus", undefined),
      sendMessage("listEnabledSites", undefined),
      customRecipes.getValue(),
      quickLinks.getValue(),
      corrections.getValue(),
      remoteRecipes.getValue(),
    ]);
    setStatus(s);
    setSites(sit);
    setRecipes(rec);
    setLinks(ql);
    setCorr(c);
    setRemote(rem);
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

  const disableSite = async (origin: string) => {
    setBusy(true);
    await sendMessage("unregisterSite", origin);
    await browser.permissions.remove({ origins: [`${origin}/*`] });
    await refresh();
    setBusy(false);
  };

  const deleteRecipe = async (id: string) => {
    const next = (await customRecipes.getValue()).filter((r) => r.id !== id);
    await customRecipes.setValue(next);
    setRecipes(next);
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
  const addLink = async () => {
    const id = `ql-${Date.now()}`;
    const site: QuickLinkSite = { id, name: "New site", enabled: true };
    const next = [...(await quickLinks.getValue()), site];
    await quickLinks.setValue(next);
    setLinks(next);
    setJustAdded(id);
  };
  const addFromRecipe = async (s: RecipeSuggestion) => {
    const id = `ql-${Date.now()}`;
    const site: QuickLinkSite = { id, name: s.name, enabled: true, movie: s.movie, tv: s.tv };
    const next = [...(await quickLinks.getValue()), site];
    await quickLinks.setValue(next);
    setLinks(next);
    setJustAdded(id);
  };

  const deleteCorrection = async (key: string) => {
    setBusy(true);
    const next = { ...(await corrections.getValue()) };
    delete next[key];
    await corrections.setValue(next);
    setCorr(next);
    setBusy(false);
  };

  const clearCorrections = async () => {
    setBusy(true);
    await corrections.setValue({});
    setCorr({});
    setBusy(false);
  };

  return (
    <main class="tmsync">
      <h1>TMSync settings</h1>
      <TraktSection status={status} busy={busy} onChange={refresh} />
      <EnabledSites sites={sites} busy={busy} onDisable={disableSite} />
      <QuickLinks
        sites={links}
        suggestions={recipeSuggestions(recipes, links)}
        busy={busy}
        onSave={saveLink}
        onDelete={deleteLink}
        onToggle={toggleLink}
        onAdd={addLink}
        onAddFromRecipe={addFromRecipe}
        justAdded={justAdded}
      />
      <RecipeLibrary remote={remote} busy={busy} note={recipeNote} onRefresh={refreshRecipes} />
      <CustomRecipes recipes={recipes} onDelete={deleteRecipe} />
      <Corrections
        entries={Object.entries(corr)}
        busy={busy}
        onDelete={deleteCorrection}
        onClear={clearCorrections}
      />
    </main>
  );
}
