import type { ScrobbleReply } from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
import { describe, expect, it } from "vitest";
import { statusFromReply } from "./session";

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
