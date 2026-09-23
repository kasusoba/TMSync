/** A short message for a failed user action. Browser sync storage throws a quota
 * error when it is full, so name that case in plain words. */
export function actionError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/quota/i.test(msg)) {
    return "Couldn’t save. Browser sync storage is full. Remove some recipes or quick links.";
  }
  return `That didn’t work: ${msg}`;
}

/** An error's message (a thrown non-Error as a string). The not-connected errors
 * already say which tracker ("Not connected to Simkl"). */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
