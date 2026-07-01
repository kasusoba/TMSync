import { beforeEach, describe, expect, it, vi } from "vitest";

// pushToAura reads its endpoint config from storage on each call (stateless SW).
const getValue = vi.fn();
vi.mock("@/lib/storage", () => ({
  auraPresence: { getValue: () => getValue() },
}));

import { pushToAura } from "./aura";
import type { PresenceState } from "./types";

const playing: PresenceState = {
  title: "Frieren",
  subtitle: "Episode 7",
  paused: false,
  startEpochMs: 1_700_000_000_000,
  endEpochMs: 1_700_000_600_000,
  posterUrl: "https://s4.anilist.co/cover.jpg",
};

const configured = {
  url: "https://aura.example.workers.dev/presence",
  token: "secret-ingest-token",
  applicationId: "1521726719151702197",
};

/** Read the (url, init) of the nth fetch call with a non-null assertion — the test
 * asserts the call happened first, so the tuple is present. */
function fetchCall(n = 0): {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
} {
  const call = fetchMock.mock.calls[n];
  if (!call) throw new Error(`fetch was not called ${n + 1} time(s)`);
  const [url, init] = call as [string, RequestInit & { headers: Record<string, string> }];
  return { url, init };
}

let fetchMock: ReturnType<typeof vi.fn>;

describe("pushToAura", () => {
  beforeEach(() => {
    getValue.mockReset();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("POSTs { application_id, activity } with the bearer token to the configured endpoint", async () => {
    getValue.mockResolvedValue(configured);
    await pushToAura(playing);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = fetchCall();
    expect(url).toBe(configured.url);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${configured.token}`);

    const body = JSON.parse(init.body as string);
    expect(body.application_id).toBe(configured.applicationId);
    expect(body.activity).toMatchObject({
      type: 3, // Watching
      details: "Frieren",
      state: "Episode 7",
      status_display_type: 2, // member list shows the title
      assets: { large_image: "https://s4.anilist.co/cover.jpg", large_text: "Frieren" },
      timestamps: { start: 1_700_000_000_000, end: 1_700_000_600_000 }, // ms, not seconds
    });
  });

  it("clears the presence by sending activity: null", async () => {
    getValue.mockResolvedValue(configured);
    await pushToAura(null);

    const body = JSON.parse(fetchCall().init.body as string);
    expect(body.activity).toBeNull();
    expect(body.application_id).toBe(configured.applicationId);
  });

  it("is inert (no fetch) when the endpoint or token is unset", async () => {
    getValue.mockResolvedValue({ url: "", token: "", applicationId: "" });
    await pushToAura(playing);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a network error so a down endpoint never throws into the SW", async () => {
    getValue.mockResolvedValue(configured);
    fetchMock.mockRejectedValue(new Error("connection refused"));
    await expect(pushToAura(playing)).resolves.toBeUndefined();
  });
});
