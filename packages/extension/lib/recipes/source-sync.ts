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
    const res = await fetch(source.url, {
      headers: current?.etag ? { "If-None-Match": current.etag } : undefined,
      credentials: "omit",
      cache: "no-cache",
    });
    if (res.status === 304 && current) {
      return { ...current, fetchedAt: Date.now(), error: undefined };
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
 * `force`, or only `onlyId`). Drops the copies of removed sources, then applies
 * the quick links.
 */
export async function refreshSources(
  opts: { force?: boolean; onlyId?: string } = {},
): Promise<RefreshResult> {
  const sources = await recipeSources.getValue();
  const caches = { ...(await sourceCaches.getValue()) };
  let changed = false;
  for (const id of Object.keys(caches)) {
    if (!sources.some((s) => s.id === id)) {
      delete caches[id];
      changed = true;
    }
  }
  let error: string | undefined;
  for (const source of sources) {
    if (!source.enabled) continue;
    if (opts.onlyId && source.id !== opts.onlyId) continue;
    const current = caches[source.id];
    const fresh = current && Date.now() - current.fetchedAt < SOURCES.refreshMs;
    if (fresh && !opts.force && !opts.onlyId) continue;
    const next = await fetchSource(source, current);
    caches[source.id] = next;
    changed = true;
    error ??= next.error;
  }
  if (changed) await sourceCaches.setValue(caches);
  await applySourceLinks();
  const count = sources
    .filter((s) => s.enabled && (!opts.onlyId || s.id === opts.onlyId))
    .reduce((n, s) => n + (caches[s.id]?.recipes.length ?? 0), 0);
  return error ? { ok: false, count, error } : { ok: true, count };
}

/**
 * Bring the quick-links store in line with the sources. A new source link arrives
 * off (the user turns on favourites). A source link keeps the user's on/off and
 * takes the source's templates. A source link that no source offers now leaves. A
 * user link is never touched, and a source link never replaces one with its id.
 */
export async function applySourceLinks(): Promise<void> {
  const [sources, caches, pins, existing] = await Promise.all([
    recipeSources.getValue(),
    sourceCaches.getValue(),
    siteSourcePins.getValue(),
    quickLinks.getValue(),
  ]);
  const offered = resolveSourceLinks(sources, caches, pins);
  const offeredIds = new Set(offered.map((l) => l.id));
  const byId = new Map(existing.map((l) => [l.id, l]));
  const next: QuickLinkSite[] = existing.filter(
    (l) => l.source !== "source" || offeredIds.has(l.id),
  );
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
      enabled: cur?.enabled ?? false,
      source: "source",
      sourceId: l.sourceId,
    };
    if (cur && JSON.stringify(cur) === JSON.stringify({ ...cur, ...row })) continue;
    const at = next.findIndex((x) => x.id === l.id);
    if (at >= 0) next[at] = { ...next[at], ...row };
    else next.push(row);
    changed = true;
  }
  if (changed) await quickLinks.setValue(next);
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
