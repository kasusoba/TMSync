/**
 * What the rate/note panel sends on Save, per tracker. Pure (unit-tested).
 *
 * The panel loads each selected tracker's own rating and note. When they agree it
 * shows the shared value; when they differ it shows "mixed" and keeps each one as
 * it is until the user changes that field. Save sends only what changed, so a
 * note edit never overwrites a rating that differs per tracker, and clearing the
 * stars removes a rating.
 */

export interface LoadedNote {
  text: string;
  spoiler: boolean;
}

/** One tracker's current review, as `getReview` returns it. */
export interface LoadedReview {
  rating: number | null;
  note: LoadedNote | null;
}

/** A field across the selected trackers: one shared value, or different ones. */
export type Shared<T> = { kind: "same"; value: T } | { kind: "mixed" };

/** Whether every value is equal (by `key`). An empty list is "same" as `empty`. */
export function agree<T>(values: T[], key: (v: T) => string, empty: T): Shared<T> {
  if (values.length === 0) return { kind: "same", value: empty };
  const first = key(values[0] as T);
  return values.every((v) => key(v) === first)
    ? { kind: "same", value: values[0] as T }
    : { kind: "mixed" };
}

const ratingKey = (r: number | null) => String(r);
const noteKey = (n: LoadedNote | null) => (n ? `${n.spoiler ? 1 : 0}:${n.text}` : "");

/** The shared rating and note across the loaded trackers. */
export function sharedReview(loaded: LoadedReview[]): {
  rating: Shared<number | null>;
  note: Shared<LoadedNote | null>;
} {
  return {
    rating: agree(
      loaded.map((l) => l.rating),
      ratingKey,
      null,
    ),
    note: agree(
      loaded.map((l) => l.note),
      noteKey,
      null,
    ),
  };
}

/** What the user has staged in the panel. */
export interface StagedReview {
  rating: number | null;
  note: string;
  spoiler: boolean;
}

/**
 * Whether the staged rating differs from what the panel showed. From a mixed
 * start the stars show empty, so only picking a rating is a change.
 */
export function ratingChanged(shown: Shared<number | null>, staged: number | null): boolean {
  return shown.kind === "mixed" ? staged !== null : staged !== shown.value;
}

/**
 * Whether the staged note differs from what the panel showed. From a mixed start
 * the box shows empty, so only typing is a change. `spoilerApplies` is false when
 * no selected tracker has a spoiler flag (only Trakt does).
 */
export function noteChanged(
  shown: Shared<LoadedNote | null>,
  staged: StagedReview,
  spoilerApplies: boolean,
): boolean {
  if (shown.kind === "mixed") return staged.note.trim() !== "";
  const text = shown.value?.text ?? "";
  if (staged.note !== text) return true;
  return spoilerApplies && !!shown.value && staged.spoiler !== shown.value.spoiler;
}

/** The calls Save makes for one tracker. */
export interface ReviewOps {
  rate?: number;
  unrate?: boolean;
  saveNote?: LoadedNote;
  deleteNote?: boolean;
}

/**
 * The calls for one tracker: only for the fields the user changed, and only where
 * this tracker's own value is different. `spoilerApplies` is whether this tracker
 * has a spoiler flag.
 */
export function planReview(
  loaded: LoadedReview,
  staged: StagedReview,
  changed: { rating: boolean; note: boolean },
  spoilerApplies: boolean,
): ReviewOps {
  const ops: ReviewOps = {};
  if (changed.rating) {
    if (staged.rating !== null && staged.rating !== loaded.rating) ops.rate = staged.rating;
    if (staged.rating === null && loaded.rating !== null) ops.unrate = true;
  }
  if (changed.note) {
    const text = staged.note.trim();
    const spoiler = spoilerApplies ? staged.spoiler : false;
    if (text) {
      const same = loaded.note?.text === staged.note && (loaded.note?.spoiler ?? false) === spoiler;
      if (!same) ops.saveNote = { text: staged.note, spoiler };
    } else if (loaded.note) {
      ops.deleteNote = true;
    }
  }
  return ops;
}
