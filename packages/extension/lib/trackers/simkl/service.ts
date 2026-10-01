import type { TrackerService } from "../service";
import { SIMKL_CHUNK, applySimkl } from "./apply";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import { HELD_STOP_ALARM, flushHeldStops, pinMatch, search } from "./client";
import { SIMKL } from "./config";
import { readSimklEntries } from "./list";
import { simklDeleteNote, simklGetReview, simklRate, simklSaveNote, simklUnrate } from "./review";

export const simklService: TrackerService = {
  readList: readSimklEntries,
  applyList: { chunk: SIMKL_CHUNK, run: applySimkl },
  status: async () => ({
    connected: await isConnected(),
    redirectUri: getRedirectUri(),
    configured: !!SIMKL.clientId,
  }),
  connect,
  disconnect,
  // The whole entry (movie or show) only, 1 to 10. No notes.
  review: {
    getReview: (m) => simklGetReview(m),
    rate: (m, _level, rating) => simklRate(m, rating),
    unrate: (m) => simklUnrate(m),
    saveNote: () => simklSaveNote(),
    deleteNote: () => simklDeleteNote(),
  },
  // Fix match and manual mode. Only a user's click searches (each call costs the
  // shared daily quota). A pick is pinned by its Simkl id.
  search: async (query, type) =>
    (await search(query, type)).map((o) => ({
      tracker: "simkl" as const,
      id: o.id,
      mediaType: o.mediaType,
      title: o.title,
      year: o.year,
      ids: o.tmdb !== undefined ? { tmdb: o.tmdb } : {},
      format: o.section === "anime" ? "anime" : undefined,
    })),
  pinPick: (media, pick) =>
    pinMatch(media, {
      id: pick.id,
      section: pick.format === "anime" ? "anime" : pick.mediaType === "movie" ? "movies" : "tv",
      title: pick.title,
      year: pick.year,
    }),
  // A stop held inside Simkl's 20 s lock, if the worker stopped before sending it.
  alarms: { [HELD_STOP_ALARM]: flushHeldStops },
};
