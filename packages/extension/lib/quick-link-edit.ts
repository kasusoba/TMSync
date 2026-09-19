import { type LinkTemplates, linkHost, normalizeHost } from "@tmsync/shared";
import type { QuickLinkSite } from "./storage";
import type { Tracker } from "./tracker/types";

/** What the popup's quick-link editor saves. */
export interface QuickLinkFields extends LinkTemplates {
  name: string;
  tracker: Tracker;
}

/** The quick link on this domain. Look it up by domain, not by id: a link made in
 * Options, or moved from another domain, does not have the id `ql-<host>`. The
 * user's own link comes first, an enabled one before a disabled one. A disabled
 * library link is only an offer from the library, so it is not this domain's link. */
export function linkOnHost(links: QuickLinkSite[], host: string): QuickLinkSite | undefined {
  const here = links.filter((l) => normalizeHost(linkHost(l)) === normalizeHost(host));
  const own = here.filter((l) => l.source !== "library");
  return own.find((l) => l.enabled) ?? own[0] ?? here.find((l) => l.enabled);
}

/** The links after saving `fields` as this domain's quick link. */
export function saveLinkOnHost(
  links: QuickLinkSite[],
  host: string,
  fields: QuickLinkFields,
  now = Date.now(),
): QuickLinkSite[] {
  const current = linkOnHost(links, host);
  const entry = (id: string): QuickLinkSite => ({
    id,
    name: fields.name,
    enabled: true,
    source: "user",
    tracker: fields.tracker,
    host: fields.host,
    movie: fields.movie,
    tv: fields.tv,
    anime: fields.anime,
    search: fields.search,
  });
  if (current && current.source !== "library") {
    return links.map((l) => (l.id === current.id ? { ...l, ...entry(l.id) } : l));
  }
  // A library link gets its templates from the library on every refresh, so an
  // edit would not last. Save a new user link and turn the library link off.
  // The id is `ql-<host>`, unless a link that moved from this domain still has it.
  const id = links.some((l) => l.id === `ql-${host}`) ? `ql-${host}-${now}` : `ql-${host}`;
  const rest = current
    ? links.map((l) => (l.id === current.id ? { ...l, enabled: false } : l))
    : links;
  return [...rest, entry(id)];
}

/** The links after removing this domain's quick link. The library adds its links
 * back on every refresh, so a library link is turned off, not deleted. */
export function removeLinkOnHost(links: QuickLinkSite[], host: string): QuickLinkSite[] {
  const current = linkOnHost(links, host);
  if (!current) return links;
  if (current.source === "library") {
    return links.map((l) => (l.id === current.id ? { ...l, enabled: false } : l));
  }
  return links.filter((l) => l.id !== current.id);
}
