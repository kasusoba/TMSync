import {
  type FrameNode,
  type RawFrame,
  buildFrameTree,
  flattenFrameTree,
} from "@/lib/diagnostics/frame-tree";
import { deriveQuickLink } from "@/lib/picker/recipe-builder";
import {
  type BadgePrefs,
  type QuickLinkSite,
  badgePrefs,
  customRecipes,
  quickLinks,
  tabFrameOrigins,
  tabSessions,
  tabStatus,
} from "@/lib/storage";
import type { Tracker } from "@/lib/tracker/types";
import { PopupView } from "@/lib/ui/kit/PopupView";
import type { QuickLinkValue } from "@/lib/ui/kit/QuickLinkEditor";
import { tokens } from "@/lib/ui/kit/kit";
import { NowPlaying } from "@/lib/ui/scrobble-panels";
import type { BadgeStatus } from "@/messaging";
import { type AniListStatus, type TraktStatus, sendMessage } from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
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
 * Inject the content script into the active tab NOW — registration only takes
 * effect on FUTURE loads, so the already-open page needs a direct inject to start
 * scrobbling without a reload. Right after the permission prompt is accepted, the
 * new host permission can lag reaching the scripting API, so the first inject may
 * throw ("Cannot access contents of the page") — retry once. Returns whether a
 * content script is now running on the page.
 */
async function injectContentNow(tabId: number): Promise<boolean> {
  const run = () =>
    browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["/content-scripts/content.js"],
    });
  try {
    await run();
    return true;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await run();
      return true;
    } catch {
      return false; // e.g. a restricted page — fall back to asking for a reload
    }
  }
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

export function App() {
  const [status, setStatus] = useState<TraktStatus | null>(null);
  const [anilist, setAnilist] = useState<AniListStatus | null>(null);
  const [topOrigin, setTopOrigin] = useState<string | null>(null);
  const [origins, setOrigins] = useState<string[]>([]); // top + every iframe origin on the page
  const [enabled, setEnabled] = useState<string[]>([]);
  // Recipe origins (synced/imported/library) not yet granted host access.
  const [pending, setPending] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Per-site quick link for the active tab's host.
  const [qlHost, setQlHost] = useState<string | null>(null);
  const [qlUrl, setQlUrl] = useState<string | null>(null);
  const [qlSite, setQlSite] = useState<QuickLinkSite | null>(null);
  // On-page badge visibility (Full / Dot / Off) — quick toggle mirrored from Options.
  const [badgeMode, setBadgeMode] = useState<BadgePrefs["mode"]>("full");
  // Frame map (diagnostics). Auto-populated (cheaply, from iframe src) on open when
  // the page has embedded frames, and shown inline always-expanded.
  const [pageHasRecipe, setPageHasRecipe] = useState(false);
  const [frameTree, setFrameTree] = useState<FrameNode[] | null>(null);
  // "Now scrobbling" for the active tab (status + media for the prompts/panels).
  const [now, setNow] = useState<{
    status: BadgeStatus;
    media: ParsedMedia | null;
    tracker: Tracker;
    trackers: Tracker[];
    tabId: number;
  } | null>(null);

  // Re-read just the scrobble status (after a prompt action, or on open).
  const refreshNow = async () => {
    const tabId = await activeTabId();
    if (tabId === null) return setNow(null);
    const [statuses, sessions] = await Promise.all([tabStatus.getValue(), tabSessions.getValue()]);
    const st = statuses[tabId];
    if (!st) return setNow(null);
    const session = sessions[tabId];
    setNow({
      status: st,
      media: session?.media ?? null,
      tracker: session?.tracker ?? "trakt",
      trackers: session?.trackers ?? [session?.tracker ?? "trakt"],
      tabId,
    });
  };

  const refresh = async () => {
    const tabId = await activeTabId();
    const [s, al, url, found, sites, links, badge, custom, pend] = await Promise.all([
      sendMessage("getTraktStatus", undefined),
      sendMessage("getAniListStatus", undefined),
      activeTabUrl(),
      tabId !== null ? collectOrigins(tabId) : Promise.resolve<string[]>([]),
      sendMessage("listEnabledSites", undefined),
      quickLinks.getValue(),
      badgePrefs.getValue(),
      customRecipes.getValue(),
      sendMessage("pendingSites", undefined),
    ]);
    // Merge the live snapshot with origins the content script accumulated over
    // the session — catches player iframes that loaded after the page settled.
    const stored = tabId !== null ? ((await tabFrameOrigins.getValue())[tabId] ?? []) : [];
    const origin = httpOrigin(url);
    const hostname = origin ? new URL(origin).hostname : null;
    const allOrigins = [...new Set([...found, ...stored])];
    // Under the broad "enable all sites" grant the catch-all content script already
    // runs everywhere, so treat this page's origins as enabled — the popup shows the
    // active state, and won't offer a per-site Enable (which would double-inject).
    const broad = await browser.permissions.contains({ origins: ["*://*/*"] });
    setStatus(s);
    setAnilist(al);
    setTopOrigin(origin);
    setOrigins(allOrigins);
    setEnabled(
      broad ? [...new Set([...sites, ...allOrigins, ...(origin ? [origin] : [])])] : sites,
    );
    setPending(pend);
    setQlHost(hostname);
    setQlUrl(url);
    setQlSite(hostname ? (links.find((l) => l.id === `ql-${hostname}`) ?? null) : null);
    setBadgeMode(badge.mode);
    // Does one of the user's OWN recipes already cover this page? Then the picker
    // opens in edit mode — so the button says "Edit recipe", not "Set up recipe".
    // urlPattern-only (the popup has no page DOM to check a domFingerprint), which
    // is enough for picker-authored recipes.
    setPageHasRecipe(
      !!url &&
        custom.some((r) => {
          try {
            return new RegExp(r.match.urlPattern).test(url);
          } catch {
            return false;
          }
        }),
    );
    // Map the page's frames (cheap: stitched from iframe `src`, NO permission prompt)
    // so the top site and any embedded player frames show as ONE indented list. Scan
    // any scriptable http page; a single-frame page just yields the one top node.
    if (tabId !== null && origin) {
      const raw = await collectFrames(tabId);
      // Under the broad grant the catch-all covers every frame, so mark them enabled
      // even though `enabledOrigins` (sites) is empty — otherwise they'd read "not
      // enabled" while scrobbling fine.
      setFrameTree(flattenFrameTree(buildFrameTree(raw, sites, broad)));
    } else {
      setFrameTree(null);
    }
    await refreshNow();
  };

  // Flip the on-page badge visibility. Preserve the dragged position; the badge
  // live-updates via badgePrefs.watch, so no reload is needed.
  const changeBadgeMode = async (mode: BadgePrefs["mode"]) => {
    setBadgeMode(mode); // optimistic
    const prev = await badgePrefs.getValue();
    await badgePrefs.setValue({ ...prev, mode });
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

  const enableOrigin = async (origin: string) => {
    setBusy(true);
    setNote(null);
    // permissions.request must run in the user-gesture (popup click) context.
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
    if (granted) {
      const res = await sendMessage("registerSite", origin);
      if (res.ok) {
        // Granting access is a clear intent to use it now, so inject into the open
        // tab immediately (registration alone only covers future loads) — no reload,
        // and it keeps the video where it is. Retries past the post-grant lag.
        const tabId = await activeTabId();
        const injected = tabId !== null && (await injectContentNow(tabId));
        setNote(injected ? "Enabled · now scrobbling on this page." : "Enabled · reload to start.");
      } else {
        setNote(res.error ?? "Failed");
      }
    } else {
      setNote("Permission denied");
    }
    // refresh() re-runs the cheap frame map, so a newly-enabled frame (now
    // reachable) shows its video state and children automatically.
    await refresh();
    setBusy(false);
  };

  // Grant a recipe origin from the "needs access" list. Same gesture-context grant
  // as enableOrigin, but the site usually isn't the active tab — so registration
  // (which covers the next load there) is enough; only inject now if it IS this page.
  const enablePending = async (origin: string) => {
    setBusy(true);
    setNote(null);
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
    if (granted) {
      const res = await sendMessage("registerSite", origin);
      if (res.ok) {
        if (origin === topOrigin) {
          const tabId = await activeTabId();
          const injected = tabId !== null && (await injectContentNow(tabId));
          setNote(
            injected ? "Enabled · now scrobbling on this page." : "Enabled · reload to start.",
          );
        } else {
          setNote(`Enabled ${origin.replace(/^https?:\/\//, "")} · active next visit.`);
        }
      } else {
        setNote(res.error ?? "Failed");
      }
    } else {
      setNote("Permission denied");
    }
    await refresh();
    setBusy(false);
  };

  // Grant EVERY pending origin in one prompt (permissions.request accepts the whole
  // list, so the browser shows a single dialog), then register each. The broad
  // "enable all sites forever" grant is a toggle in Options — this is just the
  // known pending recipes, granted in bulk.
  const enableAllPending = async () => {
    if (pending.length === 0) return;
    setBusy(true);
    setNote(null);
    const granted = await browser.permissions.request({
      origins: pending.map((o) => `${o}/*`),
    });
    if (granted) {
      for (const origin of pending) await sendMessage("registerSite", origin);
      // If the current page is among them, inject now so it starts without a reload.
      if (topOrigin && pending.includes(topOrigin)) {
        const tabId = await activeTabId();
        if (tabId !== null) await injectContentNow(tabId);
      }
      setNote(`Enabled ${pending.length} site${pending.length === 1 ? "" : "s"}.`);
    } else {
      setNote("Permission denied");
    }
    await refresh();
    setBusy(false);
  };

  const disableOrigin = async (origin: string) => {
    setBusy(true);
    await sendMessage("unregisterSite", origin);
    await browser.permissions.remove({ origins: [`${origin}/*`] });
    await refresh();
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

  // Author a recipe INSIDE a (cross-origin) player frame: the picker can't reach
  // across the frame boundary, so inject it into the frame itself. The recipe it
  // builds matches the embed's own URL and reads its own DOM/URL — and because
  // the embed is shared, that recipe works on every site using it.
  const setupFrame = async (origin: string, frameId: number) => {
    setBusy(true);
    setNote(null);
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      setNote("Permission denied");
      setBusy(false);
      return;
    }
    await sendMessage("registerSite", origin);
    const tabId = await activeTabId();
    if (tabId === null) {
      setNote("No active tab");
      setBusy(false);
      return;
    }
    try {
      await browser.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ["/content-scripts/picker.js"],
      });
      window.close(); // the picker now renders inside the player frame
    } catch (e) {
      setNote(`Couldn't open the picker in that frame: ${e instanceof Error ? e.message : e}`);
      setBusy(false);
    }
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
      pendingSites={pending}
      onEnablePending={enablePending}
      onEnableAllPending={enableAllPending}
      pageHasRecipe={pageHasRecipe}
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
      badgeMode={badgeMode}
      onBadgeMode={changeBadgeMode}
      frameTree={frameTree}
      onSetupFrame={setupFrame}
      nowPlaying={
        now && (
          <NowPlaying
            status={now.status}
            media={now.media}
            tracker={now.tracker}
            trackers={now.trackers}
            tabId={now.tabId}
            t={tokens("dark")}
            onRefresh={refreshNow}
          />
        )
      }
    />
  );
}
