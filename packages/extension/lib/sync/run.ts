/**
 * List sync, background side (plans/list-sync.md). Phase 1 reads and plans only:
 * nothing here writes to a tracker.
 *
 * Stateless (constraint #4): each call reads the settings and the crosswalk from
 * storage, reads the lists, and returns the plan. Nothing stays in memory.
 */
import { errorMessage } from "../errors";
import { listSyncSettings } from "../storage";
import { loadAnimap } from "../trackers/animap/load";
import { getAdapter } from "../trackers/index";
import { getService } from "../trackers/service";
import { ALL_TRACKERS, type Tracker } from "../trackers/types";
import { planSync, summarize, syncKindsFor, takesKind } from "./plan";
import type { ScoreScale } from "./score";
import type { ListEntry, SyncPlan, SyncTotals } from "./types";

/** One tracker's part in a preview. */
export interface TrackerRead {
  tracker: Tracker;
  /** `read` = its list is in the plan. The rest say why it is not. */
  state: "read" | "not_connected" | "off" | "failed";
  /** How many entries its list has. */
  count?: number;
  error?: string;
}

export interface SyncPreview {
  /** When the lists were read (ms). */
  at: number;
  reads: TrackerRead[];
  /** Why there is no plan (fewer than two lists read). */
  reason?: "too_few";
  /** The crosswalk is not downloaded yet, so anime cannot cross between Trakt and
   * the cour trackers. */
  noCrosswalk?: boolean;
  totals: SyncTotals[];
  plan: SyncPlan;
}

/** Read every connected tracker's list and plan the sync. Writes nothing. */
export async function previewSync(): Promise<SyncPreview> {
  const settings = await listSyncSettings.getValue();
  const reads: TrackerRead[] = [];
  const entries: ListEntry[] = [];
  const scales: Partial<Record<Tracker, ScoreScale>> = {};

  await Promise.all(
    ALL_TRACKERS.map(async (tracker) => {
      const service = getService(tracker);
      if (!service.readList) return;
      if (!syncKindsFor(tracker).some((k) => takesKind(tracker, k, settings))) {
        reads.push({ tracker, state: "off" });
        return;
      }
      const connected = await getAdapter(tracker)
        .isConnected()
        .catch(() => false);
      if (!connected) {
        reads.push({ tracker, state: "not_connected" });
        return;
      }
      try {
        const list = await service.readList();
        entries.push(...list.entries);
        if (list.scoreFormat) scales[tracker] = list.scoreFormat;
        reads.push({ tracker, state: "read", count: list.entries.length });
      } catch (e) {
        reads.push({ tracker, state: "failed", error: errorMessage(e) });
      }
    }),
  );
  reads.sort((a, b) => ALL_TRACKERS.indexOf(a.tracker) - ALL_TRACKERS.indexOf(b.tracker));

  const trackers = reads.filter((r) => r.state === "read").map((r) => r.tracker);
  const animap = await loadAnimap();
  const base = { at: Date.now(), reads, noCrosswalk: animap.size === 0 };
  if (trackers.length < 2) {
    return {
      ...base,
      reason: "too_few",
      totals: [],
      plan: { items: [], skips: [], conflicts: [] },
    };
  }
  const plan = planSync({ entries, trackers, settings, animap, scales });
  return { ...base, totals: summarize(plan, trackers), plan };
}
