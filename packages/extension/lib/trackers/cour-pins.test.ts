import { describe, expect, it } from "vitest";
import { courSearch } from "./cour-pins";
import type { CourSearchOption } from "./types";

const hits: CourSearchOption[] = [
  { id: 1, title: "Frieren", year: 2023, episodes: 28, format: "TV" },
  { id: 2, title: "Frieren Movie", episodes: 1, format: "MOVIE" },
  { id: 3, title: "Frieren OVA", episodes: 1, format: "ova" },
];

describe("courSearch (manual mode on a cour tracker)", () => {
  it("keeps series for a show and names the pick by the tracker's own id", async () => {
    const search = courSearch("anilist", async () => hits);
    expect(await search("frieren", "show")).toEqual([
      {
        tracker: "anilist",
        id: 1,
        mediaType: "show",
        title: "Frieren",
        year: 2023,
        format: "TV",
        ids: { anilist: 1 },
      },
      {
        tracker: "anilist",
        id: 3,
        mediaType: "show",
        title: "Frieren OVA",
        year: undefined,
        format: "ova",
        ids: { anilist: 3 },
      },
    ]);
  });

  it("keeps only movies for a movie (MAL names them in lower case)", async () => {
    const search = courSearch("mal", async () => [
      ...hits,
      { id: 4, title: "X", episodes: 1, format: "movie" },
    ]);
    expect((await search("frieren", "movie")).map((o) => [o.id, o.ids])).toEqual([
      [2, { mal: 2 }],
      [4, { mal: 4 }],
    ]);
  });
});
