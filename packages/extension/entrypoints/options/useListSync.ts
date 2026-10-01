import { actionError } from "@/lib/errors";
import {
  listSyncApply,
  listSyncAuto,
  listSyncAutoSeen,
  listSyncJob,
  listSyncPicks,
  listSyncSettings,
} from "@/lib/storage";
import { type ApplyJob, applyBlock, applyQueues, cancelApply, readApply } from "@/lib/sync/apply";
import { AUTO_ALARM, type AutoRun } from "@/lib/sync/auto";
import { jobAlive } from "@/lib/sync/job";
import { syncKindsFor } from "@/lib/sync/plan/index";
import { type SyncJob, readJob } from "@/lib/sync/preview";
import {
  DEFAULT_SYNC_SETTINGS,
  type ListSyncSettings,
  type SyncKind,
  type SyncPick,
  type SyncPicks,
} from "@/lib/sync/types";
import { ALL_TRACKERS, type Tracker, trackerLabel } from "@/lib/trackers/types";
import type { ListSyncView } from "@/lib/ui/kit/list-sync/ListSyncView";
import { sendMessage } from "@/messaging";
import type { ComponentProps } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { browser } from "wxt/browser";

/**
 * The List sync pane's state for the options page (docs/ARCHITECTURE.md section 7):
 * the user's choices, the preview and apply jobs as saved in storage, and the
 * handlers. Returns the props `ListSyncView` takes (all but the theme).
 * `open` = the pane is showing, so the automatic run's held items are seen.
 */
export function useListSync(open: boolean): Omit<ComponentProps<typeof ListSyncView>, "t"> {
  const [syncSettings, setSyncSettings] = useState<ListSyncSettings>(DEFAULT_SYNC_SETTINGS);
  const [syncJob, setSyncJob] = useState<SyncJob | null>(null);
  const [syncApply, setSyncApply] = useState<ApplyJob | null>(null);
  const [syncPicks, setSyncPicks] = useState<SyncPicks>({});
  const [autoRun, setAutoRun] = useState<AutoRun | null>(null);
  /** When the daily alarm fires next (ms), while automatic sync is on. */
  const [autoNext, setAutoNext] = useState<number | undefined>();
  const [syncError, setSyncError] = useState<string | undefined>();
  /** Re-render while a job runs, so a job the browser stopped shows as stopped. */
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void listSyncSettings.getValue().then(setSyncSettings);
    // readJob drops a preview saved by an older build (a different shape).
    void listSyncJob.getValue().then((job) => setSyncJob(readJob(job)));
    void listSyncApply.getValue().then((job) => setSyncApply(readApply(job)));
    void listSyncPicks.getValue().then(setSyncPicks);
    void listSyncAuto.getValue().then(setAutoRun);
    // Settings too: a backup import or another options tab can change them, and a
    // stale copy here would be saved back over them on the next toggle.
    const unwatch = [
      listSyncSettings.watch((next) => setSyncSettings(next ?? DEFAULT_SYNC_SETTINGS)),
      listSyncAuto.watch((run) => setAutoRun(run ?? null)),
      listSyncJob.watch((job) => setSyncJob(readJob(job))),
      listSyncApply.watch((job) => setSyncApply(readApply(job))),
      listSyncPicks.watch((picks) => setSyncPicks(picks ?? {})),
    ];
    return () => {
      for (const u of unwatch) u();
    };
  }, []);

  // Opening the pane shows the last automatic run, so its held items are seen: the
  // toolbar badge then counts only the ones a later run adds.
  useEffect(() => {
    if (open && autoRun?.held.length) void listSyncAutoSeen.setValue(autoRun.held).catch(() => {});
  }, [open, autoRun]);

  // The next daily run, from the alarm. The background makes the alarm after the
  // setting is saved, and moves it on each run, so read it again now and then.
  useEffect(() => {
    if (!open || !syncSettings.auto) return setAutoNext(undefined);
    const read = () =>
      void browser.alarms.get(AUTO_ALARM).then(
        (a) => setAutoNext(a?.scheduledTime),
        () => {},
      );
    read();
    const id = setInterval(read, 15_000);
    return () => clearInterval(id);
  }, [open, syncSettings.auto]);

  // Tick often while a job runs (a job the browser stopped shows as stopped), and
  // now and then while a preview waits (it goes stale for apply).
  const previewRunning = syncJob?.state === "running";
  const jobRunning = previewRunning || syncApply?.state === "running";
  const hasPreview = !!syncJob?.preview;
  useEffect(() => {
    if (!jobRunning && !hasPreview) return;
    const id = setInterval(() => setNow(Date.now()), jobRunning ? 5000 : 30_000);
    return () => clearInterval(id);
  }, [jobRunning, hasPreview]);
  const previewing = jobAlive(syncJob, now);
  const applying = jobAlive(syncApply, now);
  // The queues change only with the plan, the ignore list, and the picks: not on
  // every tick of the clock above.
  const preview = syncJob?.preview;
  const queues = useMemo(
    () => (preview ? applyQueues(preview, syncSettings.ignore, syncPicks) : null),
    [preview, syncSettings.ignore, syncPicks],
  );
  const syncBlocked = preview && queues ? applyBlock(preview, syncApply, queues, now) : null;
  // A job still "running" with no recent beat was stopped by the browser.
  // (An apply that stopped says so in its own panel.)
  const stoppedAt =
    previewRunning && !previewing
      ? syncJob?.reads.filter((r) => r.state === "reading").map((r) => trackerLabel(r.tracker))
      : undefined;
  const syncProblem =
    syncError ??
    (syncJob?.state === "failed" ? syncJob.error : undefined) ??
    (stoppedAt
      ? `The background stopped${stoppedAt.length ? ` while reading ${stoppedAt.join(", ")}` : ""}. Try again.`
      : undefined);

  const saveSyncSettings = async (next: ListSyncSettings) => {
    setSyncSettings(next);
    try {
      await listSyncSettings.setValue(next);
    } catch (e) {
      setSyncError(actionError(e));
      // Show what was saved, not the choice that failed to save.
      void listSyncSettings.getValue().then(setSyncSettings, () => {});
    }
  };

  const setSyncKind = (tk: Tracker, kind: SyncKind, on: boolean) => {
    const cur = syncSettings.kinds[tk] ?? syncKindsFor(tk);
    const next = on ? [...new Set([...cur, kind])] : cur.filter((k) => k !== kind);
    // A tracker that stops taking a kind cannot be its main list any more.
    const main = { ...syncSettings.main };
    if (!on && main[kind] === tk) delete main[kind];
    void saveSyncSettings({ ...syncSettings, main, kinds: { ...syncSettings.kinds, [tk]: next } });
  };

  const setSyncMain = (kind: SyncKind, tk: Tracker | undefined) => {
    const main = { ...syncSettings.main };
    if (tk) main[kind] = tk;
    else delete main[kind];
    void saveSyncSettings({ ...syncSettings, main });
  };

  // Start a preview job: the background reads every list and plans, and reports
  // through `listSyncJob`. Nothing is written to a tracker until Apply.
  const previewListSync = async () => {
    setSyncError(undefined);
    setNow(Date.now());
    try {
      await sendMessage("listSyncStart", undefined);
    } catch (e) {
      // "No response" at once = the background running is an older build with no
      // list sync (the extension was rebuilt but not reloaded).
      setSyncError(
        /no response/i.test(String(e))
          ? "The background didn’t answer. Reload TMSync on the extensions page and try again."
          : actionError(e),
      );
    }
  };

  // Apply the preview's plan: the background writes it and reports through
  // `listSyncApply`. It refuses a preview that is old or already applied.
  const applyListSync = async () => {
    setSyncError(undefined);
    setNow(Date.now());
    try {
      const res = await sendMessage("listSyncApply", undefined);
      if (!res.started && res.reason !== "running")
        setSyncError("Sync couldn’t apply this preview. Preview again, then apply.");
    } catch (e) {
      setSyncError(actionError(e));
    }
  };

  // Picks in disagreements, by `pickKey` (undefined = no pick: nothing is written
  // for that field). One save for many, so a bulk pick loses none.
  const pickConflicts = (picks: Record<string, SyncPick | undefined>) => {
    const next = { ...syncPicks };
    for (const [key, value] of Object.entries(picks)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    setSyncPicks(next);
    void listSyncPicks.setValue(next).catch((e) => setSyncError(actionError(e)));
  };

  // Keep one item out of sync, or bring it back (the pane hides kept-out items).
  const ignoreSyncItem = (key: string) =>
    void saveSyncSettings({ ...syncSettings, ignore: [...new Set([...syncSettings.ignore, key])] });
  const restoreSyncItem = (key: string) =>
    void saveSyncSettings({
      ...syncSettings,
      ignore: syncSettings.ignore.filter((k) => k !== key),
    });

  return {
    rows: ALL_TRACKERS.map((tk) => ({
      tracker: tk,
      can: syncKindsFor(tk),
      on: syncSettings.kinds[tk] ?? syncKindsFor(tk),
    })),
    settings: syncSettings,
    preview: syncJob?.preview ?? null,
    progress: previewing ? syncJob?.reads : undefined,
    busy: previewing,
    error: syncProblem,
    onPreview: previewListSync,
    onKind: setSyncKind,
    onSetting: (key, on) => void saveSyncSettings({ ...syncSettings, [key]: on }),
    onMain: setSyncMain,
    onIgnore: ignoreSyncItem,
    onRestore: restoreSyncItem,
    onClearIgnored: () => void saveSyncSettings({ ...syncSettings, ignore: [] }),
    picks: syncPicks,
    apply: syncApply,
    applying,
    blocked: syncBlocked,
    onApply: applyListSync,
    onCancelApply: () => void cancelApply().catch((e) => setSyncError(actionError(e))),
    onPick: (key: string, value: SyncPick | undefined) => pickConflicts({ [key]: value }),
    onPickMany: pickConflicts,
    autoRun,
    autoNow: {
      running:
        previewing && syncJob?.auto
          ? "reading"
          : applying && syncApply?.auto
            ? "applying"
            : undefined,
      next: autoNext,
    },
  };
}
