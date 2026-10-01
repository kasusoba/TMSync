import { wetrakrCorrections, wetrakrIdsCache, wetrakrResolutionCache } from "../../storage";
import type { TrackerService } from "../service";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import { saveCorrection, search } from "./client";
import { WETRAKR } from "./config";

const notYet = async () => ({ ok: false, error: "Not supported on WeTrakr yet" });

export const wetrakrService: TrackerService = {
  status: async () => ({
    connected: await isConnected(),
    redirectUri: getRedirectUri(),
    configured: !!WETRAKR.clientId,
  }),
  connect: async () => {
    await connect();
  },
  // WeTrakr's terms: when a user disconnects, delete their WeTrakr data.
  disconnect: async () => {
    await disconnect();
    await Promise.all([
      wetrakrResolutionCache.setValue({}),
      wetrakrCorrections.setValue({}),
      wetrakrIdsCache.setValue({}),
    ]);
  },
  // Rating and comments come with the review step.
  review: {
    getReview: async () => ({ rating: null, note: null }),
    rate: notYet,
    unrate: notYet,
    saveNote: notYet,
    deleteNote: notYet,
  },
  // Manual mode and the fix-match panel. A pick is pinned by its WeTrakr id, so a
  // later title search cannot drift to a remake or another year.
  search: async (query, type) =>
    (await search(query, type)).map((o) => ({
      tracker: "wetrakr" as const,
      id: o.id,
      mediaType: o.mediaType,
      title: o.title,
      year: o.year,
      ids: { ...o.ids },
    })),
  pinPick: (media, pick) =>
    saveCorrection(media, {
      mediaType: pick.mediaType,
      id: pick.id,
      title: pick.title,
      year: pick.year,
    }),
};
