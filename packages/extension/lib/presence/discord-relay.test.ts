import { describe, expect, it, vi } from "vitest";

// The relay sink reads import.meta.env.WXT_DISCORD_CLIENT_ID at module load via
// config.ts; stub a clientId so poll() produces a payload.
vi.mock("./config", () => ({
  DISCORD: { clientId: "123456789" },
  RELAY_ID: "agnaejlkbiiggajjmnpmeheigkflbnoo",
  presenceConfigured: () => true,
}));

import { discordRelaySink } from "./discord-relay";
import type { PresenceState } from "./types";

const playing: PresenceState = {
  title: "Frieren",
  subtitle: "Episode 7",
  paused: false,
  startEpochMs: 1_700_000_000_000,
  endEpochMs: 1_700_000_600_000,
  posterUrl: "https://s4.anilist.co/cover.jpg",
};

describe("discordRelaySink.poll", () => {
  it("maps a playing state to a Listening activity with poster, episode line, and a progress bar", () => {
    const out = discordRelaySink.poll(playing) as {
      clientId: string;
      presence: Record<string, unknown>;
    };
    expect(out.clientId).toBe("123456789");
    expect(out.presence).toMatchObject({
      type: 3, // Watching
      details: "Frieren",
      state: "Episode 7", // episode on its own line
      largeImageKey: "https://s4.anilist.co/cover.jpg",
      largeImageText: "Frieren", // hover = title, not the site
      status_display_type: 2, // member list shows `details` (the title)
      startTimestamp: 1_700_000_000, // ms → s
      endTimestamp: 1_700_000_600,
    });
    // No button and no small image — both removed.
    expect(out.presence).not.toHaveProperty("buttons");
    expect(out.presence).not.toHaveProperty("smallImageKey");
  });

  it("falls back to the brand asset key when there is no poster", () => {
    const out = discordRelaySink.poll({ title: "Dune", paused: false }) as {
      presence: Record<string, unknown>;
    };
    expect(out.presence.largeImageKey).toBe("tmsync");
  });

  it("omits the state line for a movie (no episode subtitle)", () => {
    const out = discordRelaySink.poll({ title: "Dune", paused: false }) as {
      presence: Record<string, unknown>;
    };
    expect(out.presence).not.toHaveProperty("state");
  });

  it("labels line 2 'Paused' and drops the progress bar when paused", () => {
    const out = discordRelaySink.poll({ ...playing, paused: true }) as {
      presence: Record<string, unknown>;
    };
    expect(out.presence.state).toBe("⏸ Paused · Episode 7");
    expect(out.presence.details).toBe("Frieren"); // member-list text stays the clean title
    expect(out.presence).not.toHaveProperty("startTimestamp");
    expect(out.presence).not.toHaveProperty("endTimestamp");
  });

  it("returns an empty object (stay registered, show nothing) for null state", () => {
    expect(discordRelaySink.poll(null)).toEqual({});
  });
});
