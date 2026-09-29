/**
 * One lock for starting a list sync job. A preview and an apply each check that no
 * job runs, then save theirs. Without a lock, an alarm and a click at the same time
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
