import { TRAKT } from "@/config";
import { errorMessage } from "@/lib/errors";
import { onMessage } from "@/messaging";
import type { TrackerService } from "../service";
import { TRAKT_CHUNK, applyTrakt } from "./apply";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import {
  TraktNotConnectedError,
  exportLetterboxd,
  idsForSlug,
  saveCorrection,
  search,
} from "./client";
import { readTraktEntries } from "./list";
import { traktDeleteNote, traktGetReview, traktRate, traktSaveNote, traktUnrate } from "./review";
import type { ReviewLevel } from "./types";
import { pickedIdentity } from "./util";

export const traktService: TrackerService = {
  readList: readTraktEntries,
  applyList: { chunk: TRAKT_CHUNK, run: applyTrakt },
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
  // Manual mode: a Trakt search, and a correction so the pick can't drift to a
  // remake or another year when the title is searched again.
  search: async (query, type) =>
    (await search(query, type)).map((o) => ({
      tracker: "trakt" as const,
      id: o.traktId,
      mediaType: o.type,
      title: o.title,
      year: o.year,
      ids: { ...o.ids },
    })),
  pinPick: (media, pick) =>
    saveCorrection(
      media,
      pickedIdentity({
        type: pick.mediaType,
        traktId: pick.id,
        title: pick.title,
        year: pick.year,
      }),
    ),
  onWake() {
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
