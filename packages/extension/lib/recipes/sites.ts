import {
  type Recipe,
  hostOf,
  normalizeHost,
  patternPath,
  recipeHosts,
  siteLabel,
  withRecipeHosts,
} from "@tmsync/shared";

/**
 * A SITE as the options page shows it: the recipes that share a domain, and the
 * domains they share. After a domain move a site has several (old and new), and
 * one recipe with both joins every recipe on either into one site.
 */
export interface SiteGroup {
  key: string;
  name: string;
  /** Storage form (`www.` kept, it is a real origin), one per comparison form. */
  hosts: string[];
  recipes: { recipe: Recipe; library: boolean }[];
}

/**
 * Group the effective recipes into sites. A custom recipe shadows the library one
 * with its id, as in the engine. A host-free recipe matches any host, so it is a
 * site of its own.
 */
export function groupSites(custom: Recipe[], library: Recipe[]): SiteGroup[] {
  const effective = [
    ...custom.map((recipe) => ({ recipe, library: false })),
    ...library
      .filter((r) => !custom.some((c) => c.id === r.id))
      .map((recipe) => ({ recipe, library: true })),
  ];
  let groups: SiteGroup[] = [];
  for (const entry of effective) {
    const hosts = recipeHosts(entry.recipe);
    if (hosts.length === 0) {
      groups.push({
        key: `any:${entry.recipe.id}`,
        name: entry.recipe.name,
        hosts: [],
        recipes: [entry],
      });
      continue;
    }
    const shared = (g: SiteGroup) =>
      g.hosts.some((h) => hosts.some((x) => normalizeHost(x) === normalizeHost(h)));
    const joined = groups.filter(shared);
    const merged: SiteGroup = {
      key: "",
      name: joined[0]?.name ?? entry.recipe.name,
      hosts: uniqueHosts([...joined.flatMap((g) => g.hosts), ...hosts]),
      recipes: [...joined.flatMap((g) => g.recipes), entry],
    };
    merged.key = `site:${normalizeHost(merged.hosts[0] ?? "")}`;
    groups = [...groups.filter((g) => !joined.includes(g)), merged];
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

/** Dedupe hosts by comparison form, keeping the first spelling seen. */
export function uniqueHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  return hosts.filter((h) => {
    const key = normalizeHost(h);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The custom recipe list after giving every recipe of a site the host list
 * `hosts`. A library recipe is forked under its own id, which shadows the library
 * version, so the next library sync cannot undo the edit.
 */
export function withSiteHosts(site: SiteGroup, hosts: string[], custom: Recipe[]): Recipe[] {
  const edited = new Set(site.recipes.map(({ recipe }) => recipe.id));
  const next = custom.map((r) => (edited.has(r.id) ? withRecipeHosts(r, hosts) : r));
  const forks = site.recipes
    .filter(({ library, recipe }) => library && !custom.some((c) => c.id === recipe.id))
    .map(({ recipe }) => withRecipeHosts(recipe, hosts));
  return [...next, ...forks];
}

/**
 * The custom recipe list after renaming a site: every custom recipe of the site
 * takes `name`. Library recipes keep theirs, because renaming one would fork it
 * and stop library fixes from reaching it, a high price for a label.
 */
export function withSiteName(site: SiteGroup, name: string, custom: Recipe[]): Recipe[] {
  const ids = new Set(site.recipes.filter((r) => !r.library).map((r) => r.recipe.id));
  return custom.map((r) => (ids.has(r.id) ? { ...r, name } : r));
}

/**
 * The site this page most likely moved from: one with the same name on another
 * domain (`cinejoy.to` for `cinejoy.pk`). Null when a site already lists this
 * domain, or none shares its name. When several do, the one with a recipe whose
 * path fits this URL wins. It is a guess, so the caller asks before acting on it.
 */
export function findMovedSite(sites: SiteGroup[], url: string): SiteGroup | null {
  const host = hostOf(url);
  const label = siteLabel(host);
  if (!label) return null;
  if (sites.some((s) => s.hosts.some((h) => normalizeHost(h) === host))) return null;
  const named = sites.filter((s) => s.hosts.some((h) => siteLabel(h) === label));
  const fitsPath = (s: SiteGroup) =>
    s.recipes.some(({ recipe }) => {
      try {
        return new RegExp(patternPath(recipe.match.urlPattern)).test(url);
      } catch {
        return false;
      }
    });
  return named.find(fitsPath) ?? named[0] ?? null;
}

/**
 * Hosts that a recipe change brings in: in `after` but in neither `before` nor
 * `others` (the other recipe list, which already covered them). The popup nudges
 * about these after a sync or an import. Storage form, like `recipeHosts`.
 */
export function addedHosts(before: Recipe[], after: Recipe[], others: Recipe[] = []): string[] {
  const known = new Set([...before, ...others].flatMap(recipeHosts).map(normalizeHost));
  const added = new Map<string, string>();
  for (const h of after.flatMap(recipeHosts)) {
    const key = normalizeHost(h);
    if (!known.has(key) && !added.has(key)) added.set(key, h);
  }
  return [...added.values()];
}
