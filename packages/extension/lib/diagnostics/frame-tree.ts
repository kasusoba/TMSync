/**
 * Frame inspector — rebuild a page's nested-iframe tree from inside the extension,
 * so we don't depend on DevTools (gray-market streaming sites routinely block it).
 *
 * The popup runs `scripting.executeScript({ allFrames: true })` over the active
 * tab. That injects into every frame the extension can reach (the top frame via
 * `activeTab`, plus any enabled cross-origin origin via its granted host
 * permission) and returns one {@link RawFrame} per reached frame, each tagged
 * with its `frameId`. A frame can read the `src` of its child `<iframe>`s even
 * cross-origin (only reaching *into* them is blocked), so a reached frame also
 * reports the URLs of its children. {@link buildFrameTree} stitches those reports
 * into the real tree: reached frames carry full video data; a child URL that no
 * reached frame matches becomes an "unreached" leaf — exactly the deeper player
 * frame the user still needs to enable.
 *
 * Pure (no DOM, no browser APIs) so it unit-tests against fixture data.
 */

export interface VideoInfo {
  paused: boolean;
  /** Seconds; 0 when unknown (live / not yet loaded). */
  duration: number;
  currentTime: number;
  /** HTMLMediaElement.readyState (0 HAVE_NOTHING … 4 HAVE_ENOUGH_DATA). */
  readyState: number;
  hasSrc: boolean;
  muted: boolean;
  loop: boolean;
  /** videoWidth / videoHeight — 0 until metadata loads. */
  width: number;
  height: number;
}

/** One frame's self-report, gathered by the injected collector. */
export interface RawFrame {
  frameId: number;
  url: string;
  origin: string;
  isTop: boolean;
  title: string;
  videos: VideoInfo[];
  /** Absolute http(s) URLs of this frame's direct child `<iframe>`s. */
  iframeSrcs: string[];
}

export interface FrameNode {
  /** frameId when our script reached the frame; null when it's known only as a
   * parent's iframe src (an origin we can't yet inject into → enable it). */
  frameId: number | null;
  url: string;
  origin: string;
  isTop: boolean;
  /** True when executeScript ran here (we have its real video data). */
  reached: boolean;
  /** Origin is in the enabled set (a content script is registered for it). */
  enabled: boolean;
  title: string;
  videos: VideoInfo[];
  /** Has a non-background `<video>` (a muted+looping trailer doesn't count). */
  hasVideo: boolean;
  /** A non-background video is actually playing here — this is the player frame. */
  hasActiveVideo: boolean;
  children: FrameNode[];
  /** Nesting depth from the top frame (0 = top). */
  depth: number;
}

/** A muted, looping video is a background trailer on a landing page, not the player. */
const isBackground = (v: VideoInfo): boolean => v.loop && v.muted;
const realVideos = (vs: VideoInfo[]): VideoInfo[] => vs.filter((v) => !isBackground(v));

/** Strip hash + a single trailing slash so iframe `src` matches a frame's `location.href`. */
function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    const s = x.href;
    return s.endsWith("/") ? s.slice(0, -1) : s;
  } catch {
    return u.replace(/#.*$/, "").replace(/\/$/, "");
  }
}

function originOf(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

function reachedNode(f: RawFrame, enabled: Set<string>, broad: boolean): FrameNode {
  const reals = realVideos(f.videos);
  return {
    frameId: f.frameId,
    url: f.url,
    origin: f.origin,
    isTop: f.isTop,
    reached: true,
    enabled: broad || enabled.has(f.origin),
    title: f.title,
    videos: f.videos,
    hasVideo: reals.length > 0,
    hasActiveVideo: reals.some((v) => !v.paused && v.readyState >= 2),
    children: [],
    depth: 0,
  };
}

function unreachedNode(src: string, enabled: Set<string>, broad: boolean): FrameNode {
  const origin = originOf(src);
  return {
    frameId: null,
    url: src,
    origin,
    isTop: false,
    reached: false,
    enabled: broad || enabled.has(origin),
    title: "",
    videos: [],
    hasVideo: false,
    hasActiveVideo: false,
    children: [],
    depth: 0,
  };
}

function setDepth(n: FrameNode, d: number): void {
  n.depth = d;
  for (const c of n.children) setDepth(c, d + 1);
}

/**
 * Stitch per-frame reports into the nested frame tree.
 *
 * @param frames each reached frame's self-report (from executeScript allFrames)
 * @param enabledOrigins origins that currently have a registered content script
 * @param broad the broad "enable all sites" grant is held → every frame is enabled
 *   (the catch-all content script covers them all, even with `enabledOrigins` empty)
 * @returns the tree roots (the top frame first), depths filled in
 */
export function buildFrameTree(
  frames: RawFrame[],
  enabledOrigins: string[],
  broad = false,
): FrameNode[] {
  const enabled = new Set(enabledOrigins);
  const reached = frames.map((f) => reachedNode(f, enabled, broad));

  // Index reached frames by normalized URL so a parent's iframe src can find them.
  const byUrl = new Map<string, FrameNode[]>();
  for (const n of reached) {
    const k = normUrl(n.url);
    const arr = byUrl.get(k);
    if (arr) arr.push(n);
    else byUrl.set(k, [n]);
  }

  // A reached frame is claimed once some parent adopts it (so it isn't also a root).
  const claimed = new Set<FrameNode>();
  reached.forEach((parent, i) => {
    const raw = frames[i];
    if (!raw) return;
    // Dedupe identical srcs (ad slots repeat the same embed) to keep the tree clean.
    for (const src of [...new Set(raw.iframeSrcs)]) {
      const match = (byUrl.get(normUrl(src)) ?? []).find((c) => c !== parent && !claimed.has(c));
      if (match) {
        claimed.add(match);
        parent.children.push(match);
      } else {
        // No reached frame here → an origin we can't inject into yet. Surfacing it
        // is the whole point: it's the candidate the user enables next.
        parent.children.push(unreachedNode(src, enabled, broad));
      }
    }
  });

  // Roots: whatever nobody claimed — the top frame, plus any orphan whose parent's
  // src didn't match (a frame that navigated after the parent captured its src).
  const roots = reached.filter((n) => !claimed.has(n));
  roots.sort((a, b) => Number(b.isTop) - Number(a.isTop));
  for (const r of roots) setDepth(r, 0);
  return roots;
}

/** Pre-order flatten (parents before children) for simple indented rendering. */
export function flattenFrameTree(roots: FrameNode[]): FrameNode[] {
  const out: FrameNode[] = [];
  const walk = (n: FrameNode): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/** The frame most likely to be the player: an active video first, else any video. */
export function findPlayerFrame(roots: FrameNode[]): FrameNode | null {
  const all = flattenFrameTree(roots);
  return all.find((n) => n.hasActiveVideo) ?? all.find((n) => n.hasVideo) ?? null;
}
