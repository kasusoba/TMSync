import { describe, expect, it } from "vitest";
import {
  type QuickLinkFields,
  linkOnHost,
  removeLinkOnHost,
  saveLinkOnHost,
} from "./quick-link-edit";
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

const FIELDS: QuickLinkFields = {
  name: "Site",
  tracker: "trakt",
  host: "a.com",
  movie: "/m/{tmdb}",
};

describe("saveLinkOnHost", () => {
  it("updates the user's own link in place", () => {
    const links = [link("ql-1", "a.com", { name: "Old" })];
    expect(saveLinkOnHost(links, "a.com", FIELDS)).toEqual([
      { id: "ql-1", enabled: true, source: "user", ...FIELDS },
    ]);
  });

  // An edit merged into a library link made it `source: "user"`, so it stopped
  // getting library updates.
  it("saves a new user link and turns the library link off", () => {
    const lib = link("lib-a", "a.com", { source: "library" });
    expect(saveLinkOnHost([lib], "a.com", FIELDS)).toEqual([
      { ...lib, enabled: false },
      { id: "ql-a.com", enabled: true, source: "user", ...FIELDS },
    ]);
  });

  it("does not reuse an id that a moved link still has", () => {
    const moved = link("ql-a.com", "b.com");
    const out = saveLinkOnHost([moved], "a.com", FIELDS, 42);
    expect(out.map((l) => l.id)).toEqual(["ql-a.com", "ql-a.com-42"]);
  });
});

describe("removeLinkOnHost on a library link", () => {
  it("turns it off, because the library would add it back", () => {
    const lib = link("lib-a", "a.com", { source: "library" });
    expect(removeLinkOnHost([lib], "a.com")).toEqual([{ ...lib, enabled: false }]);
  });
});
