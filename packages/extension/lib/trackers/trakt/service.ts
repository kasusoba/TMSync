import { TRAKT } from "@/config";
import type { TrackerService } from "../service";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import { traktDeleteNote, traktGetReview, traktRate, traktSaveNote, traktUnrate } from "./review";
import type { ReviewLevel } from "./types";

export const traktService: TrackerService = {
  status: async () => ({
    connected: await isConnected(),
    redirectUri: getRedirectUri(),
    configured: !!(TRAKT.clientId && TRAKT.clientSecret),
  }),
  connect: async () => {
    await connect();
  },
  disconnect,
  // Per level (episode, season, show) with a public comment and a spoiler flag.
  review: {
    getReview: (m, level) => traktGetReview(m, level as ReviewLevel),
    rate: (m, level, rating) => traktRate(m, level as ReviewLevel, rating),
    unrate: (m, level) => traktUnrate(m, level as ReviewLevel),
    saveNote: (m, level, text, spoiler) => traktSaveNote(m, level as ReviewLevel, text, spoiler),
    deleteNote: (m, level) => traktDeleteNote(m, level as ReviewLevel),
  },
};
