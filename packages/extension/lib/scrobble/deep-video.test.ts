import { afterEach, describe, expect, it } from "vitest";
import { openShadowRoots, shadowVideos } from "./deep-video";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shadowVideos", () => {
  it("finds a video in an open shadow root, nested ones too", () => {
    const player = document.createElement("play-av");
    const inner = document.createElement("div");
    const nested = inner.attachShadow({ mode: "open" });
    nested.appendChild(document.createElement("video"));
    player.attachShadow({ mode: "open" }).appendChild(inner);
    document.body.appendChild(player);
    expect(openShadowRoots(document)).toHaveLength(2);
    expect(shadowVideos(document)).toHaveLength(1);
  });

  it("skips TMSync's own hosts and closed roots", () => {
    const badge = document.createElement("tmsync-badge");
    badge.attachShadow({ mode: "open" }).appendChild(document.createElement("video"));
    const closed = document.createElement("x-player");
    closed.attachShadow({ mode: "closed" }).appendChild(document.createElement("video"));
    document.body.append(badge, closed);
    expect(shadowVideos(document)).toEqual([]);
  });
});
