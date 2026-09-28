import { browser } from "wxt/browser";
import { malConnectIntent, malCorrections, malMissCache, malResolutionCache } from "../../storage";
import { bindPins, courSearch, setKey } from "../cour-pins";
import type { CourTrackerService } from "../service";
import { hasMalAccess, isMalGrant } from "./access";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import { getAnime, malCacheKey, searchMal } from "./client";
import { MAL } from "./config";
import { malDeleteNote, malGetReview, malRate, malSaveNote, malUnrate } from "./review";
import type { MalIdentity } from "./types";

/** How long a popup's MAL connect intent stays good (the user answers the prompt). */
const MAL_INTENT_MS = 2 * 60 * 1000;

export const malService: CourTrackerService = {
  status: async () => ({
    connected: await isConnected(),
    redirectUri: getRedirectUri(),
    configured: !!MAL.clientId,
  }),
  connect: async () => {
    // MAL sends no CORS headers, so every call needs the host grant. The UI asks for
    // it on the Connect click (a gesture the background doesn't have).
    if (!(await hasMalAccess())) throw new Error("Allow access to MyAnimeList to connect");
    await connect();
  },
  disconnect,
  // The entry (cour) only, 1 to 10, with a private `comments` note.
  review: {
    getReview: (m) => malGetReview(m),
    rate: (m, _level, rating) => malRate(m, rating),
    unrate: (m) => malUnrate(m),
    saveNote: (m, _level, text) => malSaveNote(m, text),
    deleteNote: (m) => malDeleteNote(m),
  },
  search: courSearch("mal", searchMal),
  pins: bindPins<MalIdentity>({
    search: searchMal,
    load: getAnime,
    override: "forwardMal",
    async setCorrection(media, identity) {
      const key = malCacheKey(media);
      await setKey(malCorrections, key, identity);
      await setKey(malResolutionCache, key, undefined);
      await setKey(malMissCache, key, undefined); // a remembered miss
    },
  }),
  onWake() {
    // A first MAL grant from the popup: Firefox closes the popup at the permission
    // prompt, so the popup can't ask for the sign-in. It left an intent; sign in here.
    browser.permissions.onAdded.addListener(async (granted) => {
      if (!isMalGrant(granted.origins)) return;
      const at = await malConnectIntent.getValue();
      if (!at || Date.now() - at > MAL_INTENT_MS) return;
      await malConnectIntent.setValue(0);
      await connect().catch((e) => console.warn("[TMSync] MyAnimeList sign-in failed", e));
    });
  },
};
