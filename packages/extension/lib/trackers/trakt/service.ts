import { TRAKT } from "@/config";
import { errorMessage } from "@/lib/errors";
import { onMessage, sendMessage } from "@/messaging";
import type { TrackerService } from "../service";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import {
  TraktNotConnectedError,
  exportLetterboxd,
  idsForSlug,
  saveCorrection,
  search,
} from "./client";
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
  onWake() {
    // Fix a wrong match (Trakt's `search` fix kind): a free-text search, then pin
    // the pick and re-resolve the tab (replaces the wrong scrobble).
    onMessage("searchTrakt", async ({ data }) => {
      try {
        return await search(data.query, data.type);
      } catch {
        return [];
      }
    });

    onMessage("saveCorrection", async ({ data, sender }) => {
      await saveCorrection(data.media, data.identity);
      const tabId = data.tabId ?? sender.tab?.id;
      if (tabId !== undefined) void sendMessage("recheck", undefined, tabId);
    });

    // The ids behind a trakt.tv page slug, for the quick links on trakt.tv.
    onMessage("traktIdsForSlug", async ({ data }) => {
      try {
        return await idsForSlug(data.type, data.slug);
      } catch {
        return null;
      }
    });

    // Letterboxd import CSV from the user's Trakt movies (options page).
    onMessage("exportLetterboxd", async () => {
      try {
        const { csv, count } = await exportLetterboxd();
        return { ok: true, csv, count };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof TraktNotConnectedError ? "Not connected to Trakt" : errorMessage(e),
        };
      }
    });
  },
};
