/**
 * Host handling for recipe matching.
 *
 * Streaming sites move domain often, keeping the same UI. The recipe stays
 * correct; only the host changes. So the host is held in ONE place,
 * `match.hostnames`, which is the recipe's host scope AND the list of origins the
 * background requests permission for. A move is then one entry added to that list
 * (see docs/RECIPE-LIFECYCLE.md).
 *
 * Older recipes carry the host inside `match.urlPattern` instead (the picker used
 * to build `cineby\.at/movie`). These helpers read and rewrite that anchor so both
 * shapes work.
 */
import type { Recipe } from "./schema";

/** Escape a literal string for use inside a regular expression. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HOSTNAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * STORAGE form of a hostname: trimmed and lowercased, `www.` kept. A stored host
 * is also an origin we ask permission for, and `https://www.site.tld/*` and
 * `https://site.tld/*` are different origins, so the real one has to survive.
 */
export function hostText(hostname: string): string {
  return hostname.trim().toLowerCase();
}

/**
 * COMPARISON form: lowercased with `www.` dropped, so both spellings of a site
 * compare equal. Use it to compare hosts, never to store or request one.
 */
export function normalizeHost(hostname: string): string {
  return hostText(hostname).replace(/^www\./, "");
}

/** Hostname of a URL in comparison form, or `""` when it cannot be parsed. */
export function hostOf(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

/** Split a urlPattern into its leading token and the rest, honouring one `(?:…)` group. */
function leadToken(pattern: string): { token: string; rest: string } {
  if (pattern.startsWith("(?:")) {
    const end = pattern.indexOf(")");
    if (end > 0) return { token: pattern.slice(3, end), rest: pattern.slice(end + 1) };
    return { token: "", rest: pattern };
  }
  const slash = pattern.indexOf("/");
  if (slash < 0) return { token: pattern, rest: "" };
  return { token: pattern.slice(0, slash), rest: pattern.slice(slash) };
}

/**
 * Hosts a urlPattern is anchored to: a leading escaped hostname (`cineby\.at/movie`)
 * or an alternation of them (`(?:cineby\.at|cineby\.app)/movie`). Empty when the
 * pattern carries no host, which is what the picker writes now.
 */
export function patternHosts(urlPattern: string): string[] {
  const { token } = leadToken(urlPattern);
  if (!token) return [];
  const parts = token.split("|").map((p) => p.replace(/\\(.)/g, "$1"));
  if (!parts.every((p) => HOSTNAME_RE.test(p))) return [];
  return parts.map(hostText);
}

/** The path part of a urlPattern: the whole pattern once any host anchor is removed. */
export function patternPath(urlPattern: string): string {
  return patternHosts(urlPattern).length ? leadToken(urlPattern).rest : urlPattern;
}

/** Re-anchor a urlPattern to `hosts` (an empty list removes the anchor). */
export function withPatternHosts(urlPattern: string, hosts: string[]): string {
  // A host-only pattern leaves nothing behind; ".*" says "every page on this host"
  // in a form the picker can show and edit.
  const path = patternPath(urlPattern) || ".*";
  if (hosts.length === 0) return path;
  const escaped = hosts.map(escapeRegex);
  return (escaped.length === 1 ? escaped[0] : `(?:${escaped.join("|")})`) + path;
}

/**
 * Every host a recipe is scoped to: `match.hostnames` when set, else the host
 * anchored in `match.urlPattern`. Empty means the recipe is host-free and matches
 * on its pattern + fingerprint alone.
 */
export function recipeHosts(recipe: Recipe): string[] {
  const listed = recipe.match.hostnames?.map(hostText).filter(Boolean) ?? [];
  return listed.length ? [...new Set(listed)] : patternHosts(recipe.match.urlPattern);
}

/** Rewrite a recipe's host scope to `hosts`, keeping `hostnames` and the pattern in step. */
export function withRecipeHosts(recipe: Recipe, hosts: string[]): Recipe {
  const next = [...new Set(hosts.map(hostText).filter(Boolean))];
  return {
    ...recipe,
    match: {
      ...recipe.match,
      hostnames: next.length ? next : undefined,
      // The pattern keeps no host of its own once `hostnames` carries the scope:
      // two sources of truth would disagree the moment one of them is edited.
      urlPattern: withPatternHosts(recipe.match.urlPattern, []),
    },
  };
}

/** Second-level labels that sit under a country code (`co.uk`, `com.br`). */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu"]);

/**
 * The name part of a host: `cinejoy` for `cinejoy.to`, `www.cinejoy.pk`, or
 * `watch.cinejoy.co.uk`. A site that moves domain usually keeps it and changes
 * only the ending, so two hosts with the same label are likely one site.
 */
export function siteLabel(hostname: string): string {
  const labels = normalizeHost(hostname).split(".").filter(Boolean);
  if (labels.length < 2) return "";
  const second = labels[labels.length - 2] ?? "";
  const nameAt = labels.length >= 3 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels[labels.length - nameAt] ?? "";
}
