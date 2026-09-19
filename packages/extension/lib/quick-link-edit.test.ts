import { describe, expect, it } from "vitest";
import { removeLinkOnHost } from "./quick-link-edit";
import type { QuickLinkSite } from "./storage";

const link = (id: string, host: string, extra: Partial<QuickLinkSite> = {}): QuickLinkSite => ({
  id,
  name: host,
  enabled: true,
  source: "user",
  host,
  movie: "/movie/{tmdb}",
  ...extra,
});

describe("removeLinkOnHost", () => {
  // A link made in Options has the id `ql-<timestamp>`, not `ql-<host>`.
  it("removes the link on this domain whatever its id", () => {
    const links = [link("ql-1700000000000", "site.tld")];
    expect(removeLinkOnHost(links, "site.tld")).toEqual([]);
  });

  // A link moved from a.com to b.com keeps the id `ql-a.com`.
  it("keeps a link that moved to another domain", () => {
    const moved = link("ql-a.com", "b.com");
    const here = link("ql-a.com-1", "a.com");
    expect(removeLinkOnHost([moved, here], "a.com")).toEqual([moved]);
  });

  it("changes nothing when the domain has no link", () => {
    const links = [link("ql-b.com", "b.com")];
    expect(removeLinkOnHost(links, "a.com")).toBe(links);
  });
});
