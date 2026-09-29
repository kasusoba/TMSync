import { describeWrite } from "@/lib/sync/describe";
/** The changes table, one column per tracker, and the small table parts the other tabs share. */
import type { SyncItem } from "@/lib/sync/types";
import { type Tracker, trackerLabel } from "@/lib/trackers/types";
import clsx from "clsx";
import type { ComponentChildren } from "preact";
import { Btn, IconBtn, type Tokens, TrackerMark } from "../kit";
import { KIND_LABEL } from "./labels";

/**
 * A header cell that stays at the top of the window while its table scrolls, so
 * the tracker of each column is always in view. The cell is opaque, and its
 * bottom line is inside it: a row border would not move with a sticky cell.
 */
export function Th({ t, children }: { t: Tokens; children?: ComponentChildren }) {
  return (
    <th class={clsx("sticky top-0 z-10 p-0 align-bottom font-medium", t.cardSolid)}>
      <div class={clsx("flex h-9 items-center border-b px-3", t.divider)}>{children}</div>
    </th>
  );
}

/** "Show more" under a long table, while rows are left. */
export function ShowMore({ t, left, onMore }: { t: Tokens; left: number; onMore: () => void }) {
  if (left <= 0) return null;
  return (
    <Btn t={t} tone="ghost" onClick={onMore}>
      Show more ({left} left)
    </Btn>
  );
}

export function Empty({ t, text }: { t: Tokens; text: string }) {
  return <p class={clsx("py-6 text-center text-[12px]", t.faint)}>{text}</p>;
}

/** The plan as a table: one row per item, one column per tracker. */
export function ChangesTable({
  t,
  trackers,
  items,
  onKeepOut,
}: {
  t: Tokens;
  trackers: Tracker[];
  items: SyncItem[];
  onKeepOut: (item: SyncItem) => void;
}) {
  if (!items.length) return null;
  return (
    <div class={clsx("overflow-x-clip rounded-lg", t.card)}>
      {/* Fixed layout: the columns keep their width whatever rows a filter shows. */}
      <table class="w-full table-fixed text-[12px]">
        <colgroup>
          <col class="w-[30%]" />
          {trackers.map((tk) => (
            <col key={tk} />
          ))}
          <col class="w-10" />
        </colgroup>
        <thead>
          <tr class={clsx("text-left", t.faint)}>
            <Th t={t}>Title</Th>
            {trackers.map((tk) => (
              <Th t={t} key={tk}>
                <span class="flex items-center gap-1.5">
                  <TrackerMark tracker={tk} />
                  {trackerLabel(tk)}
                </span>
              </Th>
            ))}
            <Th t={t} />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key} class={clsx("border-b align-top last:border-b-0", t.divider)}>
              <td class="px-3 py-2">
                <span class={clsx("block", t.heading)}>
                  {item.title}
                  {item.year ? <span class={t.faint}> ({item.year})</span> : null}
                </span>
                <span class={clsx("mt-0.5 inline-block rounded px-1 py-0.5 text-[10px]", t.chip)}>
                  {KIND_LABEL[item.kind]}
                </span>
              </td>
              {trackers.map((tk) => {
                const ws = item.writes.filter((w) => w.tracker === tk);
                return (
                  <td key={tk} class={clsx("px-3 py-2", t.sub)}>
                    {ws.length ? (
                      ws.map((w) => (
                        <span key={w.op} class="block">
                          {describeWrite(w)}
                        </span>
                      ))
                    ) : (
                      <span class={t.faint}>·</span>
                    )}
                  </td>
                );
              })}
              <td class="px-1 py-1.5">
                <IconBtn
                  t={t}
                  name="eye-off"
                  title="Keep this item out of sync"
                  onClick={() => onKeepOut(item)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
