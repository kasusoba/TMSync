import type { TrackerService } from "../service";
import { connect, disconnect, getRedirectUri, isConnected } from "./auth";
import { HELD_STOP_ALARM, flushHeldStops } from "./client";
import { SIMKL } from "./config";
import { simklDeleteNote, simklGetReview, simklRate, simklSaveNote, simklUnrate } from "./review";

export const simklService: TrackerService = {
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
  // A stop held inside Simkl's 20 s lock, if the worker stopped before sending it.
  alarms: { [HELD_STOP_ALARM]: flushHeldStops },
};
