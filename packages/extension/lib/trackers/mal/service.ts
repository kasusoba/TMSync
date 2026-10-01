import { malCorrections, malMissCache, malResolutionCache } from "../../storage";
import { bindPins, courSearch, setKey } from "../cour-pins";
import { watchQuickLinksScript } from "../quicklinks-script";
import type { CourTrackerService } from "../service";
import { MAL_CHUNK, applyMal } from "./apply";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import { getAnime, malCacheKey, searchMal } from "./client";
import { MAL } from "./config";
import { readMalEntries } from "./list";
import { malDeleteNote, malGetReview, malRate, malSaveNote, malUnrate } from "./review";
import type { MalIdentity } from "./types";

export const malService: CourTrackerService = {
  readList: async () => ({ entries: await readMalEntries() }),
  applyList: { chunk: MAL_CHUNK, run: applyMal },
  status: async () => ({
    connected: await isConnected(),
    redirectUri: getRedirectUri(),
    configured: !!MAL.clientId,
  }),
  connect: async () => {
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
  // The anime quick links on myanimelist.net, while the site grant (asked on Connect) holds.
  onWake() {
    watchQuickLinksScript({ id: "mal-quicklinks", matches: ["https://myanimelist.net/*"] });
  },
};
