import { describe, expect, it } from "vitest";
import type { FrameNode } from "./frame-tree";
import { type FrameDiag, explainBadge } from "./why";

const NOW = 1_000_000;

function node(p: Partial<FrameNode> & { origin: string }): FrameNode {
  return {
    frameId: 0,
    url: `${p.origin}/`,
    isTop: false,
    reached: true,
    enabled: true,
    title: "",
    videos: [],
    hasVideo: false,
    hasActiveVideo: false,
    children: [],
    depth: 0,
    diag: null,
    ...p,
  };
}

function diag(p: Partial<FrameDiag> = {}): FrameDiag {
  return { at: NOW - 2000, checks: 3, recipes: 40, ...p };
}

const run = (frames: FrameNode[], badgeHidden = false) =>
  explainBadge({ frames, badgeHidden, now: NOW });

describe("explainBadge", () => {
  it("says to allow a site that is not allowed", () => {
    const out = run([node({ origin: "https://a.tld", isTop: true, enabled: false })]);
    expect(out).toEqual([{ tone: "bad", text: expect.stringContaining("not allowed on a.tld") }]);
  });

  it("says to reload when the site is allowed but no script runs", () => {
    const out = run([node({ origin: "https://a.tld", isTop: true })]);
    expect(out[0]).toMatchObject({ tone: "bad", text: expect.stringContaining("Reload") });
  });

  it("waits while the frame scan has not reached the page", () => {
    const out = run([node({ origin: "https://a.tld", isTop: true, reached: false })]);
    expect(out[0]?.tone).toBe("wait");
  });

  it("names each failing check of a recipe for this domain", () => {
    const out = run([
      node({
        origin: "https://a.tld",
        isTop: true,
        diag: diag({
          step: "no-match",
          candidates: [{ name: "Cinejoy", url: true, marker: false }],
        }),
      }),
    ]);
    expect(out.at(-1)).toEqual({
      tone: "bad",
      text: "Cinejoy: its page marker is not on the page (yet).",
    });
  });

  it("finds a player frame with the video but no script", () => {
    const out = run([
      node({ origin: "https://a.tld", isTop: true, diag: diag({ step: "resolved", media: "X" }) }),
      node({ origin: "https://player.tld", hasVideo: true }),
    ]);
    expect(out.at(-1)?.text).toContain("player.tld has the video");
  });

  it("points at a player frame that is not allowed", () => {
    const out = run([
      node({ origin: "https://a.tld", isTop: true, diag: diag({ step: "resolved", media: "X" }) }),
      node({ origin: "https://player.tld", reached: false, enabled: false }),
    ]);
    expect(out.at(-1)).toMatchObject({ tone: "wait", text: expect.stringContaining("player.tld") });
  });

  it("is all ok when the player runs, and flags a hidden badge", () => {
    const out = run(
      [
        node({
          origin: "https://a.tld",
          isTop: true,
          diag: diag({ step: "resolved", media: "X" }),
        }),
        node({ origin: "https://p.tld", diag: diag({ player: "running" }) }),
      ],
      true,
    );
    expect(out.map((l) => l.tone)).toEqual(["ok", "ok", "bad", "ok"]);
  });
});
