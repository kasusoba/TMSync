import { describe, expect, it } from "vitest";
import { malEntries } from "./list";

describe("malEntries", () => {
  it("reads the animelist in cour terms", () => {
    const [rewatch, unknown] = malEntries([
      {
        node: {
          id: 5114,
          title: "FMA:B",
          num_episodes: 64,
          media_type: "tv",
          nsfw: "white",
          start_season: { year: 2009 },
        },
        list_status: {
          status: "completed",
          is_rewatching: true,
          num_episodes_watched: 10,
          score: 9,
          num_times_rewatched: 2,
          updated_at: "2024-03-01T00:00:00+00:00",
        },
      },
      {
        node: { id: 1, title: "Airing", num_episodes: 0, media_type: "tv", nsfw: "black" },
        list_status: { status: "plan_to_watch", score: 0, num_episodes_watched: 0 },
      },
    ]);
    expect(rewatch).toEqual(
      expect.objectContaining({
        id: 5114,
        ids: { mal: 5114 },
        status: "REPEATING",
        progress: 10,
        repeat: 2,
        rating: 90,
        total: 64,
        adult: false,
      }),
    );
    expect(unknown).toEqual(
      expect.objectContaining({ status: "PLANNING", rating: null, total: null, adult: true }),
    );
  });
});
