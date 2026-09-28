import { anilistCorrections, anilistResolutionCache } from "../../storage";
import { bindPins, courSearch, setKey } from "../cour-pins";
import type { CourTrackerService } from "../service";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import { anilistCacheKey, legacyAnilistKey, resolveById, searchAniList } from "./client";
import { ANILIST } from "./config";
import {
  anilistDeleteNote,
  anilistGetReview,
  anilistRate,
  anilistSaveNote,
  anilistUnrate,
} from "./review";
import type { AniListIdentity } from "./types";

export const anilistService: CourTrackerService = {
  status: async () => ({
    connected: await isConnected(),
    redirectUri: getRedirectUri(),
    configured: !!(ANILIST.clientId && ANILIST.clientSecret),
  }),
  connect: async () => {
    await connect();
  },
  disconnect,
  // The cour entry only: a private note, no levels, no spoiler flag.
  review: {
    getReview: (m) => anilistGetReview(m),
    rate: (m, _level, rating) => anilistRate(m, rating),
    unrate: (m) => anilistUnrate(m),
    saveNote: (m, _level, text) => anilistSaveNote(m, text),
    deleteNote: (m) => anilistDeleteNote(m),
  },
  search: courSearch("anilist", searchAniList),
  pins: bindPins<AniListIdentity>({
    search: searchAniList,
    // The identity, not the seam item: a title pin keeps `idMal`, so MAL can follow it.
    load: resolveById,
    override: "forward",
    async setCorrection(media, identity) {
      const key = anilistCacheKey(media);
      await setKey(anilistCorrections, key, identity);
      await setKey(anilistResolutionCache, key, undefined);
      // A pin from before keys carried the season gives way to this one.
      const legacy = legacyAnilistKey(media);
      if (legacy !== undefined) await setKey(anilistCorrections, legacy, undefined);
    },
  }),
};
