import {
  wetrakrCorrections,
  wetrakrIdsCache,
  wetrakrNotes,
  wetrakrProgress,
  wetrakrRatings,
  wetrakrResolutionCache,
} from "../../storage";
import type { TrackerService } from "../service";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import { saveCorrection, search } from "./client";
import type { ReviewLevel } from "./client";
import { WETRAKR } from "./config";
import {
  wetrakrDeleteNote,
  wetrakrGetReview,
  wetrakrRate,
  wetrakrSaveNote,
  wetrakrUnrate,
} from "./review";

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
      wetrakrRatings.setValue({}),
      wetrakrNotes.setValue({}),
      wetrakrProgress.setValue({}),
    ]);
  },
  // Per level (episode, season, show) with a public comment and a spoiler flag.
  review: {
    getReview: (m, level) => wetrakrGetReview(m, level as ReviewLevel),
    rate: (m, level, rating) => wetrakrRate(m, level as ReviewLevel, rating),
    unrate: (m, level) => wetrakrUnrate(m, level as ReviewLevel),
    saveNote: (m, level, text, spoiler) => wetrakrSaveNote(m, level as ReviewLevel, text, spoiler),
    deleteNote: (m, level) => wetrakrDeleteNote(m, level as ReviewLevel),
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
