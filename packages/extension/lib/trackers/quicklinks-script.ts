import { browser } from "wxt/browser";

/** A tracker site's quick links script, registered at runtime (never at install). */
export interface QuickLinksScript {
  /** The registration id, also the content script's entrypoint name. */
  id: string;
  /** The site's origins. The script runs only while the user holds all of them. */
  matches: string[];
}

/**
 * Register a tracker site's quick links script while the user holds access to the
 * site (asked on Connect, `TRACKER_INFO.hostAccess`), and remove it when they do
 * not. Never in the install manifest (constraint #5). Safe to call on every wake
 * and permission change.
 */
export async function syncQuickLinksScript(script: QuickLinksScript): Promise<void> {
  try {
    const has = await browser.permissions.contains({ origins: script.matches });
    const on =
      (await browser.scripting.getRegisteredContentScripts({ ids: [script.id] })).length > 0;
    if (has && !on) {
      await browser.scripting.registerContentScripts([
        {
          id: script.id,
          matches: script.matches,
          js: [`content-scripts/${script.id}.js`],
          runAt: "document_idle",
          persistAcrossSessions: true,
        },
      ]);
    } else if (!has && on) {
      await browser.scripting.unregisterContentScripts({ ids: [script.id] });
    }
  } catch {
    // best effort: without it, the site just shows no quick links
  }
}

/** Keep a quick links script in step with the site grant. Call on each wake. */
export function watchQuickLinksScript(script: QuickLinksScript): void {
  void syncQuickLinksScript(script);
  browser.permissions.onAdded.addListener(() => void syncQuickLinksScript(script));
  browser.permissions.onRemoved.addListener(() => void syncQuickLinksScript(script));
}
