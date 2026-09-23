import type { ScrobbleReply } from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { mergeFollowUp, statusFromReply } from "./session";

const anime: ParsedMedia = { mediaType: "show", title: "Akame ga Kill", season: 1, episode: 24 };

describe("statusFromReply multi-track outcomes", () => {
  // The bug: a Trakt-native item that also saved to AniList showed
  // "added to history · AniList saved" — labelling only AniList, so it read as if
  // Trakt wasn't recorded, and the prose would balloon with more trackers. Now the
  // bar gets a neutral verb + structured per-tracker outcomes (rendered as marks).
  it("gives a neutral verb + one outcome per tracker when a Trakt scrobble also saved to AniList", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      action: "scrobble",
      primaryTracker: "trakt",
      derived: [{ tracker: "anilist", ok: true, action: "scrobble", completed: false }],
    };
    const status = statusFromReply("stop", reply, anime, "trakt");
    expect(status.detail).toBe("recorded");
    expect(status.trackers).toEqual([
      { tracker: "trakt", state: "ok", note: "added to history" },
      { tracker: "anilist", state: "ok", note: "saved" },
    ]);
  });

  it("keeps a derived tracker's own error text for its mark's tooltip", () => {
    const limit = "Simkl's daily request limit is used up";
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      action: "scrobble",
      primaryTracker: "trakt",
      derived: [{ tracker: "simkl", ok: false, reason: "http", httpError: limit }],
    };
    const status = statusFromReply("stop", reply, anime, "trakt");
    expect(status.trackers?.[1]).toEqual({
      tracker: "simkl",
      state: "attention",
      note: "failed",
      detail: limit,
    });
  });

  it("flags the failing tracker as attention and neutral-verbs the rest", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      action: "scrobble",
      primaryTracker: "trakt",
      derived: [{ tracker: "anilist", ok: false, reason: "not_connected" }],
    };
    const status = statusFromReply("stop", reply, anime, "trakt");
    expect(status.detail).toBe("recorded · needs attention");
    expect(status.trackers).toEqual([
      { tracker: "trakt", state: "ok", note: "added to history" },
      { tracker: "anilist", state: "attention", note: "connect" },
    ]);
  });

  it("omits a silently-skipped derived tracker (crosswalk miss) — stays single-tracker", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      action: "scrobble",
      primaryTracker: "trakt",
      derived: [{ tracker: "anilist", ok: false, skipped: true, reason: "no_match" }],
    };
    const status = statusFromReply("stop", reply, anime, "trakt");
    // Only Trakt has an outcome ⇒ single-tracker path: keep the specific text, no marks.
    expect(status.detail).toBe("added to history");
    expect(status.trackers).toBeUndefined();
  });

  it("leaves a genuinely single-tracker Trakt scrobble unchanged", () => {
    const reply: ScrobbleReply = { ok: true, resolved: true, action: "scrobble" };
    const status = statusFromReply("stop", reply, anime, "trakt");
    expect(status.detail).toBe("added to history");
    expect(status.trackers).toBeUndefined();
  });

  it("drops the scraped season for an AniList label (seasonless: E3, not S1E3)", () => {
    // aether scrapes season=1, but AniList entries are per-cour (no seasons).
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      action: "scrobble",
      primaryTracker: "anilist",
      resolvedTitle: "Akame ga Kill!",
      resolvedYear: 2014,
    };
    const status = statusFromReply("stop", reply, anime, "anilist");
    expect(status.title).toBe("Akame ga Kill! (2014) E24");
    expect(status.title).not.toContain("S1");
  });

  it("shows an 'already watched' message instead of a bare 'stopped'", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      primaryTracker: "anilist",
      resolvedTitle: "Akame ga Kill!",
      info: "already_watched",
      atEpisode: 3,
    };
    const status = statusFromReply(
      "stop",
      reply,
      { ...anime, season: undefined, episode: 2 },
      "anilist",
    );
    expect(status.state).toBe("stopped");
    expect(status.detail).toBe("already watched · AniList at ep 3");
  });

  it("marks pending trackers during play (nothing written yet)", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      action: "start",
      primaryTracker: "trakt",
      derived: [{ tracker: "anilist", ok: true }], // AniList no-op before threshold
    };
    const status = statusFromReply("start", reply, anime, "trakt");
    expect(status.state).toBe("watching");
    expect(status.detail).toBeUndefined(); // falls back to the "scrobbling" state label
    expect(status.trackers).toEqual([
      { tracker: "trakt", state: "pending", note: undefined },
      { tracker: "anilist", state: "pending", note: undefined },
    ]);
  });
});

describe("statusFromReply rewatch prompt", () => {
  const cour: ParsedMedia = { mediaType: "show", title: "Frieren", episode: 3 };

  it("lists the native cour tracker that asked for a rewatch", () => {
    const reply: ScrobbleReply = {
      ok: false,
      resolved: true,
      reason: "needs_rewatch",
      primaryTracker: "mal",
    };
    const status = statusFromReply("start", reply, cour, "mal");
    expect(status.rewatch).toBe(true);
    expect(status.rewatchTrackers).toEqual(["mal"]);
  });

  it("raises the prompt for a derived tracker too, and lists every one that asked", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      action: "start",
      primaryTracker: "trakt",
      derived: [
        { tracker: "anilist", ok: false, reason: "needs_rewatch" },
        { tracker: "mal", ok: false, reason: "needs_rewatch" },
      ],
    };
    const status = statusFromReply("start", reply, cour, "trakt");
    expect(status.rewatch).toBe(true);
    expect(status.rewatchTrackers).toEqual(["anilist", "mal"]);
  });

  it("names a cour tracker in its own saved note", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      action: "scrobble",
      primaryTracker: "mal",
      completed: true,
    };
    expect(statusFromReply("stop", reply, cour, "mal").detail).toBe("completed on MyAnimeList");
  });
});

describe("statusFromReply multi-track already watched", () => {
  const ep5: ParsedMedia = { mediaType: "show", title: "Trigun Stargaze", episode: 5 };

  // The Trigun case: AniList already at ep 5, MAL at ep 3. MAL still records, so the
  // item is NOT "already watched"; only AniList's mark says so.
  it("shows the normal state while another tracker still records", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      info: "already_watched",
      atEpisode: 5,
      primaryTracker: "anilist",
      derived: [{ tracker: "mal", ok: true }],
    };
    const status = statusFromReply("start", reply, ep5, "anilist");
    expect(status.state).toBe("watching");
    expect(status.trackers).toEqual([
      { tracker: "anilist", state: "pending", note: "already watched" },
      { tracker: "mal", state: "pending", note: undefined },
    ]);
  });

  it("says recorded once the other tracker writes at the threshold", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      info: "already_watched",
      atEpisode: 5,
      primaryTracker: "anilist",
      derived: [{ tracker: "mal", ok: true, action: "scrobble", completed: false }],
    };
    const status = statusFromReply("stop", reply, ep5, "anilist");
    expect(status.state).toBe("scrobbled");
    expect(status.detail).toBe("recorded");
  });

  it("says already watched only when every tracker already counts the episode", () => {
    const reply: ScrobbleReply = {
      ok: true,
      resolved: true,
      info: "already_watched",
      atEpisode: 5,
      primaryTracker: "anilist",
      derived: [{ tracker: "mal", ok: true, info: "already_watched" }],
    };
    const status = statusFromReply("start", reply, ep5, "anilist");
    expect(status.state).toBe("stopped");
    expect(status.detail).toBe("already watched");
  });

  it("keeps 'already watched' on the main badge for a rewatch and names who asked", () => {
    const reply: ScrobbleReply = {
      ok: false,
      resolved: true,
      reason: "needs_rewatch",
      primaryTracker: "anilist",
    };
    const status = statusFromReply("start", reply, ep5, "anilist");
    expect(status.state).toBe("stopped");
    expect(status.detail).toBe("already watched · completed on AniList");
    expect(status.rewatchTrackers).toEqual(["anilist"]);
  });
});

describe("a stop's deferred trackers (Simkl waiting out its lock)", () => {
  const reply: ScrobbleReply = {
    ok: true,
    resolved: true,
    action: "scrobble",
    primaryTracker: "trakt",
    derived: [{ tracker: "simkl", ok: true, deferred: true }],
  };

  it("shows the deferred tracker as pending while it records", () => {
    const status = statusFromReply("stop", reply, anime, "trakt");
    expect(status.detail).toBe("recorded");
    expect(status.trackers).toEqual([
      { tracker: "trakt", state: "ok", note: "added to history" },
      { tracker: "simkl", state: "pending", note: "recording" },
    ]);
  });

  it("takes the real outcome from the follow-up", () => {
    const merged = mergeFollowUp(reply, [{ tracker: "simkl", ok: true, action: "scrobble" }]);
    expect(statusFromReply("stop", merged, anime, "trakt").trackers).toEqual([
      { tracker: "trakt", state: "ok", note: "added to history" },
      { tracker: "simkl", state: "ok", note: "added to history" },
    ]);
  });

  it("keeps the other trackers' outcomes as they were", () => {
    const both: ScrobbleReply = {
      ...reply,
      derived: [
        { tracker: "anilist", ok: false, reason: "not_connected" },
        { tracker: "simkl", ok: true, deferred: true },
      ],
    };
    const merged = mergeFollowUp(both, [
      { tracker: "simkl", ok: false, reason: "http" },
      { tracker: "anilist", ok: true, action: "scrobble" },
    ]);
    expect(merged.derived).toEqual([
      { tracker: "anilist", ok: false, reason: "not_connected" },
      { tracker: "simkl", ok: false, reason: "http" },
    ]);
  });
});
