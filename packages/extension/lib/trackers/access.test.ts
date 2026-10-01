import { describe, expect, it } from "vitest";
import { accessRefusedNote, hasTrackerAccess, isTrackerGrant, needsHostAccess } from "./access";

describe("tracker host access", () => {
  it("is needed only by trackers that list origins", () => {
    expect(needsHostAccess("mal")).toBe(true);
    expect(needsHostAccess("trakt")).toBe(false);
    expect(needsHostAccess("simkl")).toBe(true); // simkl.com, for its quick links
  });

  it("counts as granted for a tracker that needs none", async () => {
    expect(await hasTrackerAccess("trakt")).toBe(true);
  });

  it("matches a grant only when every origin is in it", () => {
    const both = ["https://myanimelist.net/*", "https://api.myanimelist.net/*"];
    expect(isTrackerGrant("mal", both)).toBe(true);
    expect(isTrackerGrant("mal", both.slice(0, 1))).toBe(false);
    expect(isTrackerGrant("mal", undefined)).toBe(false);
    expect(isTrackerGrant("trakt", both)).toBe(false);
  });

  it("names the site in the refusal note", () => {
    expect(accessRefusedNote("mal")).toBe(
      "MyAnimeList needs access to myanimelist.net to connect.",
    );
  });
});
