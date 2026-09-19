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
  // Keep the id of the link already on this domain. Else `ql-<host>`, unless a
  // link that moved from this domain still has that id.
  const qid =
    current?.id ?? (links.some((l) => l.id === `ql-${host}`) ? `ql-${host}-${now}` : `ql-${host}`);
  const entry: QuickLinkSite = {
    id: qid,
    name: fields.name,
    enabled: true,
    source: "user",
    tracker: fields.tracker,
    host: fields.host,
    movie: fields.movie,
    tv: fields.tv,
    anime: fields.anime,
    search: fields.search,
  };
  return current ? links.map((l) => (l.id === qid ? { ...l, ...entry } : l)) : [...links, entry];
}

/** The links after removing this domain's quick link. */
export function removeLinkOnHost(links: QuickLinkSite[], host: string): QuickLinkSite[] {
  const current = linkOnHost(links, host);
  return current ? links.filter((l) => l.id !== current.id) : links;
}
