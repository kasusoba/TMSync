import type { ParsedMedia } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { anilistCacheKey, mediaToIdentity } from "./client";

describe("mediaToIdentity", () => {
  it("prefers the English title, falls back to romaji", () => {
    expect(
      mediaToIdentity({ id: 1, episodes: 12, title: { english: "Frieren", romaji: "Sousou" } }),
    ).toMatchObject({ id: 1, title: "Frieren", episodes: 12 });
    expect(mediaToIdentity({ id: 2, title: { romaji: "Sousou no Frieren" } })).toMatchObject({
      title: "Sousou no Frieren",
    });
  });

  it("maps start year, idMal, and a null episode count for ongoing entries", () => {
    expect(
      mediaToIdentity({ id: 3, idMal: 99, episodes: null, startDate: { year: 2023 }, title: {} }),
    ).toEqual({ id: 3, title: "AniList #3", year: 2023, episodes: null, idMal: 99 });
  });
});

describe("anilistCacheKey", () => {
  it("keys on lowercased title + year and ignores the episode", () => {
    const a: ParsedMedia = { mediaType: "show", title: "Frieren", year: 2023, episode: 5 };
    const b: ParsedMedia = {
      mediaType: "show",
      title: "  FRIEREN  ".trim(),
      year: 2023,
      episode: 9,
    };
    expect(anilistCacheKey(a)).toBe(anilistCacheKey(b));
    expect(anilistCacheKey(a)).toBe("frieren:2023");
  });

  it("keeps seasons apart, so a pin for one season never applies to another", () => {
    const s1: ParsedMedia = { mediaType: "show", title: "Frieren", year: 2023, season: 1 };
    const s2: ParsedMedia = { ...s1, season: 2 };
    expect(anilistCacheKey(s1)).toBe("frieren:2023:s1");
    expect(anilistCacheKey(s1)).not.toBe(anilistCacheKey(s2));
  });
});
