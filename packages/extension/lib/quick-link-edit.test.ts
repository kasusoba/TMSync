import { describe, expect, it } from "vitest";
import { linkOnHost, removeLinkOnHost } from "./quick-link-edit";
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

describe("linkOnHost", () => {
  it("prefers the user's own link over a library link", () => {
    const lib = link("lib-a", "a.com", { source: "library" });
    const own = link("ql-a.com", "a.com");
    expect(linkOnHost([lib, own], "a.com")).toBe(own);
  });

  it("prefers an enabled link over a disabled one", () => {
    const off = link("ql-1", "a.com", { enabled: false });
    const on = link("ql-2", "a.com");
    expect(linkOnHost([off, on], "a.com")).toBe(on);
  });

  // It used to show as "Quick link added" although the link was off.
  it("ignores a disabled library link", () => {
    expect(
      linkOnHost([link("lib-a", "a.com", { source: "library", enabled: false })], "a.com"),
    ).toBe(undefined);
  });
});
