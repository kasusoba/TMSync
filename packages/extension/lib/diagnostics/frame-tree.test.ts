import { describe, expect, it } from "vitest";
import {
  type FrameNode,
  type NavFrame,
  type RawFrame,
  type VideoInfo,
  buildFrameTree,
  buildFrameTreeFromNav,
  findPlayerFrame,
  flattenFrameTree,
} from "./frame-tree";

/** Narrow `T | undefined` to `T`, failing the test if absent — avoids `!`. */
function defined<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a defined value");
  return v;
}

function vid(p: Partial<VideoInfo> = {}): VideoInfo {
  return {
    paused: true,
    duration: 0,
    currentTime: 0,
    readyState: 0,
    hasSrc: false,
    muted: false,
    loop: false,
    width: 0,
    height: 0,
    ...p,
  };
}

function frame(p: Partial<RawFrame> & { frameId: number; url: string }): RawFrame {
  return {
    origin: new URL(p.url).origin,
    isTop: false,
    title: "",
    videos: [],
    iframeSrcs: [],
    ...p,
  };
}

describe("buildFrameTree", () => {
  it("nests rive → vsrc.su → deep player and marks the unreached player to enable", () => {
    // The rivestream case: top + the enabled aggregator are reached; the real
    // player is a frame deeper than vsrc.su, on an origin we can't inject into.
    const frames: RawFrame[] = [
      frame({
        frameId: 0,
        url: "https://www.rivestream.app/watch?id=5",
        isTop: true,
        iframeSrcs: ["https://vsrc.su/embed/5"],
      }),
      frame({
        frameId: 12,
        url: "https://vsrc.su/embed/5",
        iframeSrcs: ["https://deepcdn.xyz/stream/abc"],
      }),
    ];
    const roots = buildFrameTree(frames, ["https://www.rivestream.app", "https://vsrc.su"]);
    const top = defined(roots[0]);

    expect(top.isTop).toBe(true);
    expect(top.origin).toBe("https://www.rivestream.app");
    expect(top.children).toHaveLength(1);

    const aggregator = defined(top.children[0]);
    expect(aggregator.origin).toBe("https://vsrc.su");
    expect(aggregator.reached).toBe(true);
    expect(aggregator.enabled).toBe(true);
    expect(aggregator.depth).toBe(1);

    const player = defined(aggregator.children[0]);
    expect(player.origin).toBe("https://deepcdn.xyz");
    expect(player.reached).toBe(false); // we couldn't inject — the actionable leaf
    expect(player.enabled).toBe(false);
    expect(player.frameId).toBeNull();
    expect(player.depth).toBe(2);
  });

  it("matches an iframe src to a reached frame despite a trailing slash / hash", () => {
    const frames: RawFrame[] = [
      frame({
        frameId: 0,
        url: "https://top.example/",
        isTop: true,
        iframeSrcs: ["https://player.example/e/9#start"],
      }),
      frame({ frameId: 3, url: "https://player.example/e/9" }),
    ];
    const top = defined(buildFrameTree(frames, [])[0]);
    expect(top.children).toHaveLength(1);
    expect(top.children[0]?.reached).toBe(true);
    expect(top.children[0]?.frameId).toBe(3);
  });

  it("flags the frame with a playing, non-background video as the player", () => {
    const frames: RawFrame[] = [
      frame({
        frameId: 0,
        url: "https://top.example/",
        isTop: true,
        // a muted, looping background trailer — must NOT count as the player
        videos: [vid({ paused: false, loop: true, muted: true, readyState: 4 })],
        iframeSrcs: ["https://player.example/e"],
      }),
      frame({
        frameId: 7,
        url: "https://player.example/e",
        videos: [vid({ paused: false, readyState: 4, duration: 5400, currentTime: 120 })],
      }),
    ];
    const roots = buildFrameTree(frames, []);
    const top = defined(roots[0]);
    expect(top.hasActiveVideo).toBe(false); // background trailer excluded

    const player = findPlayerFrame(roots);
    expect(player?.origin).toBe("https://player.example");
    expect(player?.hasActiveVideo).toBe(true);
  });

  it("orders multiple roots with the top frame first and flattens pre-order", () => {
    const frames: RawFrame[] = [
      // an orphan first to prove sorting puts top ahead of it
      frame({ frameId: 9, url: "https://orphan.example/x" }),
      frame({
        frameId: 0,
        url: "https://top.example/",
        isTop: true,
        iframeSrcs: ["https://a.example/1"],
      }),
      frame({ frameId: 4, url: "https://a.example/1" }),
    ];
    const roots = buildFrameTree(frames, []);
    expect(roots[0]?.isTop).toBe(true);

    const flat = flattenFrameTree(roots);
    expect(flat.map((n) => n.origin)).toEqual([
      "https://top.example",
      "https://a.example",
      "https://orphan.example",
    ]);
  });
});

describe("buildFrameTreeFromNav (webNavigation — real committed URLs)", () => {
  it("shows the REAL redirected origin, not the iframe src attribute", () => {
    // The iframe src says vsrc.su, but the frame redirected to cloudnestra — which
    // is what getAllFrames reports. We can't inject there (no perm) → not reached,
    // and that's the origin the user must actually enable.
    const nav: NavFrame[] = [
      { frameId: 0, parentFrameId: -1, url: "https://www.rivestream.app/watch?id=5" },
      { frameId: 12, parentFrameId: 0, url: "https://cloudnestra.com/rcp/abc" },
    ];
    const roots = buildFrameTreeFromNav(
      nav,
      [{ frameId: 0, title: "Rive", videos: [] }], // only top reached
      ["https://www.rivestream.app", "https://vsrc.su"], // vsrc.su enabled but irrelevant
    );
    const top = defined(roots[0]);
    expect(top.isTop).toBe(true);
    const player = defined(top.children[0]);
    expect(player.origin).toBe("https://cloudnestra.com");
    expect(player.reached).toBe(false);
    expect(player.enabled).toBe(false); // enabling vsrc.su did nothing — this is the real one
    expect(player.depth).toBe(1);
  });

  it("re-parents an http player across a dropped about:blank ad frame", () => {
    const nav: NavFrame[] = [
      { frameId: 0, parentFrameId: -1, url: "https://top.example/" },
      { frameId: 5, parentFrameId: 0, url: "about:blank" }, // ad shell, dropped
      { frameId: 9, parentFrameId: 5, url: "https://player.example/e" },
    ];
    const roots = buildFrameTreeFromNav(
      nav,
      [{ frameId: 9, title: "", videos: [vid({ paused: false, readyState: 4 })] }],
      [],
    );
    const top = defined(roots[0]);
    // about:blank is gone; the player hangs directly off the top frame.
    expect(top.children).toHaveLength(1);
    expect(top.children[0]?.origin).toBe("https://player.example");
    expect(findPlayerFrame(roots)?.origin).toBe("https://player.example");
  });
});
