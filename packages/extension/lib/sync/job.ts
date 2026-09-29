/**
 * What the preview job (`preview.ts`) and the apply job (`apply.ts`) share. Each job
 * lives in one storage item, not in memory: it saves each step, and beats while it
 * runs, so the options page can tell a running job from one the browser stopped.
 *
 * The beat timer, a retry sleep, and the lists a preview reads live in memory
 * while the job runs. That is the one scoped exception to constraint #4
 * (CLAUDE.md): a job is bounded, and a worker stopped mid-job loses only time
 * (the saved caches and the writes taken stay; the next preview plans the rest).
 */
import { browser } from "wxt/browser";

/** How often a running job saves a beat. Each save is an extension API call,
 * which also keeps the worker from being stopped as idle. */
const BEAT_MS = 10_000;

/** A running job with no beat for this long was stopped by the browser. */
export const STALE_MS = 3 * BEAT_MS;

/** Whether a saved job is still really running. Pure. */
export function jobAlive(
  job: { state: string; beatAt: number } | null | undefined,
  now: number,
): boolean {
  return job?.state === "running" && now - job.beatAt < STALE_MS;
}

/** A reader for a saved job of shape version `v`: null when the job is missing or
 * from an older build (bump the version whenever the shape changes, so an old job
 * is dropped instead of rendering fields it does not have). Pure. */
export function versioned<J extends { v: number }>(v: number): (raw: unknown) => J | null {
  return (raw) => {
    const job = raw as J | null;
    return job && job.v === v ? job : null;
  };
}

/** A running job's saves: `save` merges a patch, sets the beat, and queues the
 * write, so two steps never overwrite each other. A timer beats until `stop`. */
export function jobRunner<J extends { beatAt: number }>(
  item: { setValue(value: NoInfer<J>): Promise<void> },
  start: J,
) {
  let job = start;
  let saving: Promise<void> = Promise.resolve();
  const save = (patch: Partial<J>) => {
    job = { ...job, ...patch, beatAt: Date.now() };
    const snapshot = job;
    saving = saving.then(() => item.setValue(snapshot)).catch(() => {});
    return saving;
  };
  const beat = setInterval(() => {
    void save({});
    browser.runtime.getPlatformInfo().catch(() => {});
  }, BEAT_MS);
  return {
    get: () => job,
    save,
    /** Stop the beat and wait for the queued saves. */
    stop: async () => {
      clearInterval(beat);
      await saving;
    },
  };
}

/**
 * One lock for starting a job. A preview and an apply each check that no job
 * runs, then save theirs. Without a lock, an alarm and a click at the same time
 * both pass the check and both start.
 *
 * The Web Locks API where there is one (MV3 workers, Firefox): the browser frees the
 * lock if the worker stops. Else a promise chain in this module. That chain holds no
 * session state (constraint #4): it only orders two starts, and a stopped worker
 * loses nothing by forgetting it.
 */
const LOCK = "tmsync-list-sync";

let tail: Promise<unknown> = Promise.resolve();

/** Run `fn` while no other `exclusive` call runs. Hold it only for the check and
 * the first save, never for a whole job. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks) return locks.request(LOCK, fn) as Promise<T>;
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}
