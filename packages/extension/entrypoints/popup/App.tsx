import {
  type FrameNode,
  type RawFrame,
  buildFrameTree,
  flattenFrameTree,
} from "@/lib/diagnostics/frame-tree";
import { deriveQuickLink } from "@/lib/picker/recipe-builder";
import { effectiveRecipes, loadRecipeState } from "@/lib/recipes";
import { linkOnHost, removeLinkOnHost, saveLinkOnHost } from "@/lib/recipes/quick-link-edit";
import { type SiteGroup, findMovedSite, groupSites } from "@/lib/recipes/sites";
import {
  type BadgePrefs,
  type QuickLinkSite,
  type SiteGrantIntent,
  badgePrefs,
  connectIntent,
  newPendingSites,
  optionsIntent,
  quickLinks,
  siteGrantIntent,
  tabFrameOrigins,
  tabSessions,
  tabStatus,
  trackerTokens,
} from "@/lib/storage";
import {
  accessRefusedNote,
  hasTrackerAccess,
  needsHostAccess,
  requestTrackerAccess,
} from "@/lib/trackers/access";
import { type Tracker, trackerLabel } from "@/lib/trackers/types";
import { type Accounts, loadAccounts } from "@/lib/ui/accounts";
import { PopupView } from "@/lib/ui/kit/PopupView";
import type { QuickLinkValue } from "@/lib/ui/kit/QuickLinkEditor";
import { tokens } from "@/lib/ui/kit/kit";
import { NowPlaying } from "@/lib/ui/scrobble-panels";
import type { BadgeStatus, SiteGrantOutcome } from "@/messaging";
import { sendMessage } from "@/messaging";
import { type ParsedMedia, matchesUrl } from "@tmsync/shared";
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
          // This runs in the content script's isolated world, so it can read the
          // record the content script keeps here (FRAME_DIAG_KEY in
          // lib/diagnostics/why.ts; a literal, the injected function cannot import).
          diag: (globalThis as unknown as Record<string, unknown>).__tmsyncDiag ?? null,
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
  const [accounts, setAccounts] = useState<Accounts>({});
  const [topOrigin, setTopOrigin] = useState<string | null>(null);
  /** The active tab, read on open: a grant must not await anything before its prompt. */
  const [tabId, setTabId] = useState<number | null>(null);
  const [origins, setOrigins] = useState<string[]>([]); // top + every iframe origin on the page
  const [enabled, setEnabled] = useState<string[]>([]);
  // Sites a sync or import added that still need access (until reviewed or dismissed).
  const [newSites, setNewSites] = useState<string[]>([]);
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
  /** A site of yours that this page's domain probably moved from (same name). */
  const [movedSite, setMovedSite] = useState<SiteGroup | null>(null);
  const [frameTree, setFrameTree] = useState<FrameNode[] | null>(null);
  // "Now scrobbling" for the active tab (status + media for the prompts/panels).
  const [now, setNow] = useState<{
    status: BadgeStatus;
    media: ParsedMedia | null;
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
      trackers: session ? (session.trackers ?? [session.tracker]) : [],
      tabId,
    });
  };

  const refresh = async () => {
    const tabId = await activeTabId();
    setTabId(tabId);
    const [acc, url, found, sites, links, badge, recipeState, pending, fresh] = await Promise.all([
      loadAccounts(),
      activeTabUrl(),
      tabId !== null ? collectOrigins(tabId) : Promise.resolve<string[]>([]),
      sendMessage("listEnabledSites", undefined),
      quickLinks.getValue(),
      badgePrefs.getValue(),
      loadRecipeState(),
      sendMessage("pendingSites", undefined),
      newPendingSites.getValue(),
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
    setAccounts(acc);
    setTopOrigin(origin);
    setOrigins(allOrigins);
    setEnabled(
      broad ? [...new Set([...sites, ...allOrigins, ...(origin ? [origin] : [])])] : sites,
    );
    // Nudge about new sites that still need access, but not this page's sites
    // ("This page" asks for those).
    const here = new Set([...allOrigins, ...(origin ? [origin] : [])]);
    setNewSites(fresh.filter((o) => pending.includes(o) && !here.has(o)));
    setQlHost(hostname);
    setQlUrl(url);
    setQlSite(hostname ? (linkOnHost(links, hostname) ?? null) : null);
    setBadgeMode(badge.mode);
    // Does one of the user's OWN recipes already cover this page? Then the picker
    // opens in edit mode — so the button says "Edit recipe", not "Set up recipe".
    // Host scope + urlPattern (the popup has no page DOM to check a
    // domFingerprint), which is enough for picker-authored recipes.
    setPageHasRecipe(!!url && recipeState.custom.some((r) => matchesUrl(r, url)));
    setMovedSite(url ? findMovedSite(groupSites(effectiveRecipes(recipeState)), url) : null);
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

  // The background may finish a sign-in on its own (see connectTracker).
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe once
  useEffect(() => {
    const stops = Object.values(trackerTokens).map((item) => item.watch(() => void refresh()));
    return () => {
      for (const stop of stops) stop();
    };
  }, []);

  const connectTracker = async (tracker: Tracker) => {
    setNote(null);
    if (needsHostAccess(tracker)) {
      // Everything here starts while the click still counts as a gesture. On Firefox
      // the permission prompt closes the popup, so after a FIRST grant the background
      // signs in (it watches for the grant and reads the intent). With access already
      // granted, no prompt shows and the popup connects as usual.
      void connectIntent.setValue({ tracker, at: Date.now() });
      const had = hasTrackerAccess(tracker).catch(() => false);
      const granted = await requestTrackerAccess(tracker).catch(() => false);
      if (!granted) {
        void connectIntent.setValue(null);
        setNote(accessRefusedNote(tracker));
        return;
      }
      if (!(await had)) {
        setNote(`Finish signing in to ${trackerLabel(tracker)} in the window that opened.`);
        return;
      }
      void connectIntent.setValue(null);
    }
    setBusy(true);
    const res = await sendMessage("connectTracker", tracker);
    if (!res.ok) setNote(res.error ?? `${trackerLabel(tracker)} connection failed`);
    await refresh();
    setBusy(false);
  };

  const saveQuickLink = async (v: QuickLinkValue) => {
    if (!qlHost) return;
    setBusy(true);
    await quickLinks.setValue(saveLinkOnHost(await quickLinks.getValue(), qlHost, v));
    await refresh();
    setNote(`Quick link saved for ${qlHost}.`);
    setBusy(false);
  };

  const removeQuickLink = async () => {
    if (!qlHost) return;
    setBusy(true);
    await quickLinks.setValue(removeLinkOnHost(await quickLinks.getValue(), qlHost));
    await refresh();
    setNote(`Quick link removed for ${qlHost}.`);
    setBusy(false);
  };

  /**
   * Ask for access to an origin, then run the step it was asked for. The background
   * runs that step (`finishSiteGrant`), from a stored intent, so it still happens
   * when the permission prompt closes the popup: one click is always enough.
   */
  const grantAndFinish = async (
    intent: Omit<SiteGrantIntent, "at" | "tabId">,
  ): Promise<SiteGrantOutcome | "denied" | "noTab"> => {
    if (tabId === null) return "noTab";
    // Nothing is awaited before the request: Firefox accepts permissions.request
    // only while it still handles the click. The intent write starts first, so it
    // is on its way even when the prompt closes the popup.
    const saved = siteGrantIntent.setValue({ ...intent, tabId, at: Date.now() });
    let granted = false;
    try {
      granted = await browser.permissions.request({ origins: [`${intent.origin}/*`] });
    } catch {
      granted = false;
    }
    await saved;
    if (!granted) {
      await siteGrantIntent.setValue(null);
      return "denied";
    }
    return sendMessage("finishSiteGrant", undefined);
  };

  /** The note for a grant that failed, or null when it went through. */
  const grantError = (out: SiteGrantOutcome | "denied" | "noTab"): string | null =>
    out === "denied"
      ? "Permission denied"
      : out === "noTab"
        ? "No active tab"
        : out.ok
          ? null
          : (out.error ?? "Failed");

  const enableOrigin = async (origin: string) => {
    setBusy(true);
    setNote(null);
    const out = await grantAndFinish({ action: "enable", origin });
    // Granting access is a clear intent to use it now, so the background injects
    // into the open tab at once (no reload, the video stays where it is).
    setNote(
      grantError(out) ??
        (typeof out === "object" && out.done && !out.live
          ? "Allowed · reload to start."
          : "Allowed · now scrobbling on this page."),
    );
    // refresh() re-runs the cheap frame map, so a newly-enabled frame (now
    // reachable) shows its video state and children automatically.
    await refresh();
    setBusy(false);
  };

  // The site moved here: add this domain to all its recipes, then turn it on.
  const adoptMovedSite = async () => {
    if (!movedSite || !topOrigin) return;
    setBusy(true);
    setNote(null);
    const out = await grantAndFinish({ action: "adopt", origin: topOrigin });
    const name = (typeof out === "object" && out.siteName) || movedSite.name;
    setNote(
      grantError(out) ??
        (typeof out === "object" && out.done && !out.live
          ? `Added to ${name} · reload to start.`
          : `Added to ${name} · now scrobbling on this page.`),
    );
    await refresh();
    setBusy(false);
  };

  // Clear the new-sites list so the nudge goes away. "Review" also opens Options
  // on the Sites tab with the "Needs access" filter on.
  const clearNewSites = async () => {
    await newPendingSites.setValue([]);
    setNewSites([]);
  };
  const reviewNewSites = async () => {
    await clearNewSites();
    await optionsIntent.setValue({ section: "sites", needsAccess: true });
    await browser.runtime.openOptionsPage();
  };

  // Grant + register the top origin, then inject the element picker.
  const setupSite = async () => {
    if (!topOrigin) return;
    setBusy(true);
    setNote(null);
    const err = grantError(await grantAndFinish({ action: "setup", origin: topOrigin }));
    if (err) {
      setNote(err);
      setBusy(false);
      return;
    }
    window.close(); // get out of the way so the picker is visible
  };

  // Author a recipe INSIDE a (cross-origin) player frame: the picker can't reach
  // across the frame boundary, so inject it into the frame itself. The recipe it
  // builds matches the embed's own URL and reads its own DOM/URL — and because
  // the embed is shared, that recipe works on every site using it.
  const setupFrame = async (origin: string, frameId: number) => {
    setBusy(true);
    setNote(null);
    const out = await grantAndFinish({ action: "setupFrame", origin, frameId });
    const err = grantError(out);
    if (err) {
      setNote(
        out === "denied" || out === "noTab"
          ? err
          : `Couldn't open the picker in that frame: ${err}`,
      );
      setBusy(false);
      return;
    }
    window.close(); // the picker now renders inside the player frame
  };

  return (
    <PopupView
      variant="dark"
      connected={Object.values(accounts).some((a) => a?.connected)}
      busy={busy}
      note={note}
      origins={origins.map((origin) => ({
        origin,
        isTop: origin === topOrigin,
        enabled: enabled.includes(origin),
      }))}
      onConnectTracker={connectTracker}
      onEnable={enableOrigin}
      newSites={newSites.length}
      onReviewNewSites={reviewNewSites}
      onDismissNewSites={clearNewSites}
      onSetup={setupSite}
      pageHasRecipe={pageHasRecipe}
      movedSite={movedSite && qlHost ? { name: movedSite.name, host: qlHost } : null}
      onAdoptMovedSite={adoptMovedSite}
      onOpenOptions={() => browser.runtime.openOptionsPage()}
      quickLinkHost={qlHost}
      quickLinkInitial={
        qlSite
          ? {
              name: qlSite.name,
              tracker: qlSite.tracker ?? "trakt",
              host: qlSite.host,
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
