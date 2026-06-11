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
  it("keys on lowercased title + year and ignores season/episode", () => {
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
});
