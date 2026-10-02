import { SOURCES } from "@/config";
import { parseLibrary } from "@tmsync/shared";
import {
  type QuickLinkSite,
  type RecipeSource,
  type SourceCache,
  quickLinks,
  recipeSources,
  siteSourcePins,
  sourceCaches,
  sourceLinkMemory,
} from "../storage";
import { resolveSourceLinks } from "./sources";

/**
 * Fetching recipe sources and applying their quick links. Background only: it is
 * called on startup, on the refresh alarm, and on the options page's Refresh. No
 * state is held between calls (constraint #4), everything is in storage.
 */

export interface RefreshResult {
  ok: boolean;
  /** Recipes across the refreshed sources. */
  count: number;
  /** The first failure, for the options page's one-line status. */
  error?: string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Run `fn` alone among the writers of one storage key. Two refreshes (an add in
 * Options and the startup refresh, say) each write the whole map, so without this
 * one would drop the other's result. Web Locks hold across the worker and pages.
 */
async function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return locks ? locks.request(name, fn) : fn();
}

/**
 * True when TMSync holds host access for the source URL. Only then may a refresh
 * send `If-None-Match`: on a host read by CORS alone it is not a safelisted
 * header, so it would force a preflight that the host may refuse.
 */
async function hasHostAccess(url: string): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
  } catch {
    return false;
  }
}

/**
 * Fetch one source. Conditional (`If-None-Match`), size-capped, and validated
 * before it is kept. A failure keeps the last good copy and records the error,
 * so a source that is down for a day does not drop its sites.
 */
async function fetchSource(source: RecipeSource, current?: SourceCache): Promise<SourceCache> {
  const keep = (error: string): SourceCache => ({
    ...(current ?? { recipes: [], links: [] }),
    fetchedAt: Date.now(),
    error,
  });
  try {
    const conditional = current?.etag && (await hasHostAccess(source.url));
    const res = await fetch(source.url, {
      headers: conditional && current?.etag ? { "If-None-Match": current.etag } : undefined,
      credentials: "omit",
      cache: "no-cache",
    });
    if (res.status === 304 && current) {
      const { error: _old, ...rest } = current;
      return { ...rest, fetchedAt: Date.now(), okAt: Date.now() };
    }
    if (!res.ok) return keep(`HTTP ${res.status}`);
    const length = Number(res.headers.get("Content-Length") ?? 0);
    if (length > SOURCES.maxBytes) return keep("The file is too large.");
    const text = await res.text();
    if (text.length > SOURCES.maxBytes) return keep("The file is too large.");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return keep("The file is not JSON.");
    }
    const lib = parseLibrary(json);
    const cache: SourceCache = {
      recipes: lib.recipes,
      links: lib.links,
      fetchedAt: Date.now(),
      okAt: Date.now(),
    };
    if (lib.name) cache.name = lib.name;
    if (lib.homepage) cache.homepage = lib.homepage;
    const etag = res.headers.get("ETag");
    if (etag) cache.etag = etag;
    return cache;
  } catch (e) {
    return keep(errorText(e));
  }
}

/**
 * Refresh the enabled sources whose copy is older than the TTL (all of them when
 * `force`, or only `onlyId`), then apply the quick links. Each copy is written
 * right after its own fetch, under a lock, and only if the source still exists,
 * so a source removed during the fetch leaves no copy behind. Copies of removed
 * sources are pruned by the `recipeSources` watcher in the background.
 */
export async function refreshSources(
  opts: { force?: boolean; onlyId?: string } = {},
): Promise<RefreshResult> {
  const sources = await recipeSources.getValue();
  const before = await sourceCaches.getValue();
  let error: string | undefined;
  let count = 0;
  for (const source of sources) {
    if (!source.enabled) continue;
    if (opts.onlyId && source.id !== opts.onlyId) continue;
    const current = before[source.id];
    const fresh = current && Date.now() - current.fetchedAt < SOURCES.refreshMs;
    if (fresh && !opts.force && !opts.onlyId) {
      count += current.recipes.length;
      continue;
    }
    const next = await fetchSource(source, current);
    error ??= next.error;
    count += next.recipes.length;
    await exclusive("tmsync-source-caches", async () => {
      if (!(await recipeSources.getValue()).some((s) => s.id === source.id)) return;
      await sourceCaches.setValue({ ...(await sourceCaches.getValue()), [source.id]: next });
    });
  }
  await applySourceLinks();
  return error ? { ok: false, count, error } : { ok: true, count };
}

/** Drop the copies of sources that are no longer in the list. */
export async function pruneSourceCaches(): Promise<void> {
  await exclusive("tmsync-source-caches", async () => {
    const ids = new Set((await recipeSources.getValue()).map((s) => s.id));
    const caches = await sourceCaches.getValue();
    const kept = Object.fromEntries(Object.entries(caches).filter(([id]) => ids.has(id)));
    if (Object.keys(kept).length !== Object.keys(caches).length) {
      await sourceCaches.setValue(kept);
    }
  });
}

/**
 * Bring the quick-links store in line with the sources. A new source link arrives
 * off (the user turns on favourites). A source link keeps the user's on/off and
 * takes the source's templates. A source link that no source offers now leaves; if
 * the user had it on, `sourceLinkMemory` keeps that, so turning a source off and on
 * again restores it. A user link is never touched, and a source link never
 * replaces one with its id.
 */
export async function applySourceLinks(): Promise<void> {
  const [sources, caches, pins, existing, memory] = await Promise.all([
    recipeSources.getValue(),
    sourceCaches.getValue(),
    siteSourcePins.getValue(),
    quickLinks.getValue(),
    sourceLinkMemory.getValue(),
  ]);
  const offered = resolveSourceLinks(sources, caches, pins);
  const offeredIds = new Set(offered.map((l) => l.id));
  const byId = new Map(existing.map((l) => [l.id, l]));
  const remembered = { ...memory };
  const next: QuickLinkSite[] = [];
  for (const l of existing) {
    if (l.source !== "source" || offeredIds.has(l.id)) next.push(l);
    else if (l.enabled) remembered[l.id] = true;
  }
  let changed = next.length !== existing.length;
  for (const l of offered) {
    const cur = byId.get(l.id);
    if (cur && cur.source !== "source") continue;
    const row: QuickLinkSite = {
      id: l.id,
      name: l.name,
      tracker: l.tracker,
      host: l.host,
      movie: l.movie,
      tv: l.tv,
      anime: l.anime,
      search: l.search,
      enabled: cur?.enabled ?? remembered[l.id] ?? false,
      source: "source",
      sourceId: l.sourceId,
    };
    delete remembered[l.id];
    if (cur && JSON.stringify(cur) === JSON.stringify({ ...cur, ...row })) continue;
    const at = next.findIndex((x) => x.id === l.id);
    if (at >= 0) next[at] = { ...next[at], ...row };
    else next.push(row);
    changed = true;
  }
  if (changed) await quickLinks.setValue(next);
  if (JSON.stringify(remembered) !== JSON.stringify(memory)) {
    await sourceLinkMemory.setValue(remembered);
  }
}

/**
 * One-time move off the central library: drop its cache, and keep every quick
 * link it gave as the user's own, so nobody loses a link they turned on. Safe to
 * run on every wake.
 */
export async function migrateFromLibrary(): Promise<void> {
  await browser.storage.local.remove("remote_recipes");
  const links = await quickLinks.getValue();
  const legacy = (l: QuickLinkSite) => (l.source as string | undefined) === "library";
  if (!links.some(legacy)) return;
  await quickLinks.setValue(links.map((l) => (legacy(l) ? { ...l, source: "user" } : l)));
}
