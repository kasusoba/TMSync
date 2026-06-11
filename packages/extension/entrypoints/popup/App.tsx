import { tabFrameOrigins } from "@/lib/storage";
import { PopupView } from "@/lib/ui/proto/PopupView";
import { type AniListStatus, type TraktStatus, sendMessage } from "@/messaging";
import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";

async function activeTabOrigin(): Promise<string | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const url = new URL(tab.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
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

export function App() {
  const [status, setStatus] = useState<TraktStatus | null>(null);
  const [anilist, setAnilist] = useState<AniListStatus | null>(null);
  const [topOrigin, setTopOrigin] = useState<string | null>(null);
  const [origins, setOrigins] = useState<string[]>([]); // top + every iframe origin on the page
  const [enabled, setEnabled] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    const tabId = await activeTabId();
    const [s, al, o, found, sites] = await Promise.all([
      sendMessage("getTraktStatus", undefined),
      sendMessage("getAniListStatus", undefined),
      activeTabOrigin(),
      tabId !== null ? collectOrigins(tabId) : Promise.resolve<string[]>([]),
      sendMessage("listEnabledSites", undefined),
    ]);
    // Merge the live snapshot with origins the content script accumulated over
    // the session — catches player iframes that loaded after the page settled.
    const stored = tabId !== null ? ((await tabFrameOrigins.getValue())[tabId] ?? []) : [];
    setStatus(s);
    setAnilist(al);
    setTopOrigin(o);
    setOrigins([...new Set([...found, ...stored])]);
    setEnabled(sites);
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
    />
  );
}
