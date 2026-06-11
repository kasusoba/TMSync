import {
  type FrameNode,
  type FrameVideoReport,
  type NavFrame,
  type RawFrame,
  buildFrameTree,
  buildFrameTreeFromNav,
  flattenFrameTree,
} from "@/lib/diagnostics/frame-tree";
import { deriveQuickLink } from "@/lib/picker/recipe-builder";
import { type QuickLinkSite, quickLinks, tabFrameOrigins } from "@/lib/storage";
import { PopupView } from "@/lib/ui/proto/PopupView";
import type { QuickLinkValue } from "@/lib/ui/proto/QuickLinkEditor";
import { type AniListStatus, type TraktStatus, sendMessage } from "@/messaging";
import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";

async function activeTabUrl(): Promise<string | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? null;
}

function httpOrigin(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/**
 * The top origin plus every http(s) iframe origin on the page — the player is
 * often in a cross-origin iframe, and the content script needs to run there too.
 * Runs in the top frame under `activeTab` (reads iframe src attributes only).
 */
async function collectOrigins(tabId: number): Promise<string[]> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const set = new Set<string>([location.origin]);
        for (const frame of Array.from(document.querySelectorAll("iframe"))) {
          try {
            const u = new URL((frame as HTMLIFrameElement).src, location.href);
            if (u.protocol === "http:" || u.protocol === "https:") set.add(u.origin);
          } catch {
            // ignore unparseable/empty iframe src
          }
        }
        return Array.from(set);
      },
    });
    const out = results[0]?.result;
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/**
 * Inject into EVERY reachable frame of the active tab and have each report its
 * videos + child-iframe srcs. `allFrames` reaches the top frame (via activeTab)
 * and any enabled cross-origin frame (via its granted host permission); each
 * result carries the `frameId`. Unreachable deeper frames still surface as a
 * parent's iframe src (stitched by buildFrameTree). Rebuilds the page's frame
 * tree without DevTools (which these sites block).
 */
async function collectFrames(tabId: number): Promise<RawFrame[]> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const videos = Array.from(document.querySelectorAll("video")).map((v) => ({
          paused: v.paused,
          duration: Number.isFinite(v.duration) ? v.duration : 0,
          currentTime: v.currentTime || 0,
          readyState: v.readyState,
          hasSrc: !!(v.currentSrc || v.getAttribute("src")),
          muted: v.muted,
          loop: v.loop,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0,
        }));
        const iframeSrcs: string[] = [];
        for (const f of Array.from(document.querySelectorAll("iframe"))) {
          try {
            const u = new URL((f as HTMLIFrameElement).src, location.href);
            if (u.protocol === "http:" || u.protocol === "https:") iframeSrcs.push(u.href);
          } catch {
            // empty/unparseable iframe src — skip
          }
        }
        return {
          url: location.href,
          origin: location.origin,
          isTop: window === window.top,
          title: document.title,
          videos,
          iframeSrcs,
        };
      },
    });
    return results
      .filter((r) => r.result)
      .map((r) => ({ frameId: r.frameId ?? 0, ...(r.result as Omit<RawFrame, "frameId">) }));
  } catch {
    return [];
  }
}

/** Optional `webNavigation` permission, requested on the inspect gesture. Calling
 * request when already granted is a no-op that returns true. */
async function ensureWebNav(): Promise<boolean> {
  try {
    return await browser.permissions.request({ permissions: ["webNavigation"] });
  } catch {
    return false;
  }
}

/**
 * Every frame's REAL committed URL + exact parent, via webNavigation — sees
 * through redirect-chain embeds (the iframe `src` attribute lies). null when the
 * permission isn't granted (caller falls back to src-attribute stitching).
 */
async function getAllFrames(tabId: number): Promise<NavFrame[] | null> {
  try {
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    return (frames ?? []).map((f) => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      url: f.url,
    }));
  } catch {
    return null;
  }
}

export function App() {
  const [status, setStatus] = useState<TraktStatus | null>(null);
  const [anilist, setAnilist] = useState<AniListStatus | null>(null);
  const [topOrigin, setTopOrigin] = useState<string | null>(null);
  const [origins, setOrigins] = useState<string[]>([]); // top + every iframe origin on the page
  const [enabled, setEnabled] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Per-site quick link for the active tab's host.
  const [qlHost, setQlHost] = useState<string | null>(null);
  const [qlUrl, setQlUrl] = useState<string | null>(null);
  const [qlSite, setQlSite] = useState<QuickLinkSite | null>(null);
  // Frame inspector (diagnostics).
  const [inspecting, setInspecting] = useState(false);
  const [frameTree, setFrameTree] = useState<FrameNode[] | null>(null);

  const refresh = async () => {
    const tabId = await activeTabId();
    const [s, al, url, found, sites, links] = await Promise.all([
      sendMessage("getTraktStatus", undefined),
      sendMessage("getAniListStatus", undefined),
      activeTabUrl(),
      tabId !== null ? collectOrigins(tabId) : Promise.resolve<string[]>([]),
      sendMessage("listEnabledSites", undefined),
      quickLinks.getValue(),
    ]);
    // Merge the live snapshot with origins the content script accumulated over
    // the session — catches player iframes that loaded after the page settled.
    const stored = tabId !== null ? ((await tabFrameOrigins.getValue())[tabId] ?? []) : [];
    const origin = httpOrigin(url);
    const hostname = origin ? new URL(origin).hostname : null;
    setStatus(s);
    setAnilist(al);
    setTopOrigin(origin);
    setOrigins([...new Set([...found, ...stored])]);
    setEnabled(sites);
    setQlHost(hostname);
    setQlUrl(url);
    setQlSite(hostname ? (links.find((l) => l.id === `ql-${hostname}`) ?? null) : null);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once when the popup opens
  useEffect(() => {
    void refresh();
  }, []);

  const connect = async () => {
    setBusy(true);
    setNote(null);
    const res = await sendMessage("connectTrakt", undefined);
    if (!res.ok) setNote(res.error ?? "Connection failed");
    await refresh();
    setBusy(false);
  };

  const disconnect = async () => {
    setBusy(true);
    await sendMessage("disconnectTrakt", undefined);
    await refresh();
    setBusy(false);
  };

  const connectAniList = async () => {
    setBusy(true);
    setNote(null);
    const res = await sendMessage("connectAniList", undefined);
    if (!res.ok) setNote(res.error ?? "AniList connection failed");
    await refresh();
    setBusy(false);
  };

  const disconnectAniList = async () => {
    setBusy(true);
    await sendMessage("disconnectAniList", undefined);
    await refresh();
    setBusy(false);
  };

  const saveQuickLink = async (v: QuickLinkValue) => {
    if (!qlHost) return;
    setBusy(true);
    const qid = `ql-${qlHost}`;
    const entry: QuickLinkSite = {
      id: qid,
      name: v.name,
      enabled: true,
      source: "user",
      tracker: v.tracker,
      movie: v.movie,
      tv: v.tv,
      anime: v.anime,
      search: v.search,
    };
    const links = await quickLinks.getValue();
    const next = links.some((l) => l.id === qid)
      ? links.map((l) => (l.id === qid ? { ...l, ...entry } : l))
      : [...links, entry];
    await quickLinks.setValue(next);
    await refresh();
    setNote(`Quick link saved for ${qlHost}.`);
    setBusy(false);
  };

  const removeQuickLink = async () => {
    if (!qlHost) return;
    setBusy(true);
    const links = await quickLinks.getValue();
    await quickLinks.setValue(links.filter((l) => l.id !== `ql-${qlHost}`));
    await refresh();
    setNote(`Quick link removed for ${qlHost}.`);
    setBusy(false);
  };

  // Map the active tab's frames into a tree. webNavigation gives each frame's
  // real committed URL (so a redirect-chain embed shows its true origin, not the
  // misleading iframe src); executeScript adds video state where reachable.
  // Enabling the real player origin and rescanning then reaches it.
  const scanFrames = async () => {
    // Request webNavigation first, while the click is still a fresh user gesture.
    const haveNav = await ensureWebNav();
    setBusy(true);
    const tabId = await activeTabId();
    if (tabId === null) {
      setFrameTree([]);
      setBusy(false);
      return;
    }
    const [raw, sites] = await Promise.all([
      collectFrames(tabId),
      sendMessage("listEnabledSites", undefined),
    ]);
    const nav = haveNav ? await getAllFrames(tabId) : null;
    if (nav) {
      const reports: FrameVideoReport[] = raw.map((f) => ({
        frameId: f.frameId,
        title: f.title,
        videos: f.videos,
      }));
      setFrameTree(flattenFrameTree(buildFrameTreeFromNav(nav, reports, sites)));
    } else {
      // Fallback (permission denied): stitch by the iframe src attribute.
      setFrameTree(flattenFrameTree(buildFrameTree(raw, sites)));
    }
    setBusy(false);
  };

  const toggleInspect = async () => {
    if (inspecting) {
      setInspecting(false);
      return;
    }
    setInspecting(true);
    await scanFrames();
  };

  const enableOrigin = async (origin: string) => {
    setBusy(true);
    setNote(null);
    // permissions.request must run in the user-gesture (popup click) context.
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
    if (granted) {
      const res = await sendMessage("registerSite", origin);
      setNote(res.ok ? "Enabled — reload the page to start." : (res.error ?? "Failed"));
    } else {
      setNote("Permission denied");
    }
    await refresh();
    // Re-map: a newly-enabled frame is now reachable, so its children appear.
    if (inspecting) await scanFrames();
    setBusy(false);
  };

  const disableOrigin = async (origin: string) => {
    setBusy(true);
    await sendMessage("unregisterSite", origin);
    await browser.permissions.remove({ origins: [`${origin}/*`] });
    await refresh();
    if (inspecting) await scanFrames();
    setBusy(false);
  };

  // Grant + register the top origin, then inject the element picker.
  const setupSite = async () => {
    if (!topOrigin) return;
    setBusy(true);
    setNote(null);
    const tabId = await activeTabId();
    if (tabId === null) {
      setNote("No active tab");
      setBusy(false);
      return;
    }
    const granted = await browser.permissions.request({ origins: [`${topOrigin}/*`] });
    if (!granted) {
      setNote("Permission denied");
      setBusy(false);
      return;
    }
    await sendMessage("registerSite", topOrigin);
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["/content-scripts/picker.js"],
    });
    window.close(); // get out of the way so the picker is visible
  };

  return (
    <PopupView
      variant="dark"
      connected={status?.connected ?? false}
      redirectUri={status?.redirectUri}
      anilistConnected={anilist?.connected ?? false}
      busy={busy}
      note={note}
      origins={origins.map((origin) => ({
        origin,
        isTop: origin === topOrigin,
        enabled: enabled.includes(origin),
      }))}
      onConnect={connect}
      onDisconnect={disconnect}
      onConnectAniList={connectAniList}
      onDisconnectAniList={disconnectAniList}
      onEnable={enableOrigin}
      onDisable={disableOrigin}
      onSetup={setupSite}
      onOpenOptions={() => browser.runtime.openOptionsPage()}
      quickLinkHost={qlHost}
      quickLinkInitial={
        qlSite
          ? {
              name: qlSite.name,
              tracker: qlSite.tracker ?? "trakt",
              movie: qlSite.movie,
              tv: qlSite.tv,
              anime: qlSite.anime,
              search: qlSite.search,
            }
          : null
      }
      quickLinkDerive={(tracker) => (qlUrl ? deriveQuickLink(qlUrl, tracker) : {})}
      onSaveQuickLink={saveQuickLink}
      onRemoveQuickLink={removeQuickLink}
      inspecting={inspecting}
      frameTree={frameTree}
      onToggleInspect={toggleInspect}
      onScanFrames={scanFrames}
    />
  );
}
