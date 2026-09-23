import { RECIPES } from "@/config";
import type { QuickLinkSite } from "@/lib/storage";
import type { Tracker } from "@/lib/tracker/types";
import type { Recipe } from "@tmsync/shared";

/**
 * Contributing site config (recipes / quick links) to the central repo, with NO
 * backend (constraint #7): a one-click prefilled GitHub issue carrying a
 * self-describing, merge-ready payload, so a maintainer or an issue→PR bot can
 * route + merge it with minimal cleanup (see STORAGE-SYNC.md "Contribution").
 *
 * ONLY site config is contributable — corrections, manual picks and the crosswalk
 * are watch-revealing and never leave the device (constraint #6).
 */

/** A self-describing contribution entry — routing lives in the payload. */
export interface ContributionEntry {
  kind: "recipe" | "quicklink";
  /** Which tracker(s) this writes to. The library is ONE tracker-agnostic file
   *  (recipes/index.json) — each recipe carries its own `tracker`, so this is for
   *  display/back-compat, not file routing. */
  tracker: Tracker;
  /** The client always proposes "add"; the bot/maintainer flips to "update" on an
   *  existing id (and reviews foreign-author updates) — never a silent overwrite. */
  action: "add";
  id: string;
  schemaVersion?: number;
  /** Library-shaped data: local-only fields (enabled/source) already stripped. */
  data: unknown;
}

export interface Contribution {
  /** The new-issue URL: title, label, and body are always filled in. */
  url: string;
  /** The raw payload JSON. */
  json: string;
  /** GitHub caps the prefilled-issue URL length. Past that (a large bundle), the
   *  body asks the user to paste the JSON, so copy `json` to the clipboard first. */
  paste: boolean;
}

function recipeEntry(r: Recipe): ContributionEntry {
  // Recipes carry no device-local fields beyond the schema, so the recipe IS the
  // library payload. It all lands in the single recipes/index.json; the recipe's
  // own `tracker` field is what routes it at runtime.
  return {
    kind: "recipe",
    tracker: r.tracker ?? "trakt",
    action: "add",
    id: r.id,
    schemaVersion: r.schemaVersion,
    data: r,
  };
}

function quicklinkEntry(s: QuickLinkSite): ContributionEntry {
  const { enabled: _enabled, source: _source, ...rest } = s; // strip local-only fields
  const tracker = s.tracker ?? "trakt";
  return { kind: "quicklink", tracker, action: "add", id: s.id, data: { ...rest, tracker } };
}

const URL_LIMIT = 7000; // GitHub rejects very long prefilled-issue URLs

const PASTE_HERE = "Replace this line with the JSON that TMSync copied for you.";

/** A readable line per entry, so the author and the reviewer see what is inside. */
function describe(e: ContributionEntry): string {
  const d = e.data as { name?: string; mediaType?: string };
  if (e.kind === "quicklink") return `- Quick link: ${d.name ?? e.id}`;
  const type = d.mediaType && d.mediaType !== "auto" ? ` (${d.mediaType})` : "";
  return `- Recipe: ${d.name ?? e.id}${type}`;
}

function issueUrl(title: string, lines: string[], block: string): string {
  const body = [
    ...lines,
    "",
    "**What happens next:** a maintainer checks this issue. Then a bot opens a pull request with the JSON below and comments here with the link. After the merge, the change reaches every TMSync user with the next library sync.",
    "",
    "```json",
    block,
    "```",
  ].join("\n");
  const u = new URL(`${RECIPES.contributeUrl}/issues/new`);
  u.searchParams.set("title", title);
  u.searchParams.set("body", body);
  // Applied only when the author may label (the maintainer). For anyone else the
  // maintainer adds it after a check, and that starts the bot.
  u.searchParams.set("labels", "contribution");
  return u.toString();
}

function build(title: string, entries: ContributionEntry[]): Contribution {
  const json = JSON.stringify(entries.length === 1 ? entries[0] : entries, null, 2);
  const n = entries.length;
  const list = entries.map(describe);
  const url = issueUrl(
    title,
    [
      `Contribution from TMSync: ${n} ${n === 1 ? "item" : "items"}. Submit this issue as it is.`,
      "",
      ...list,
    ],
    json,
  );
  if (url.length <= URL_LIMIT) return { url, json, paste: false };
  // Too long to prefill: the same issue, with a paste step for the JSON. Keep the
  // item list short enough that this URL fits too.
  const shown = list.length > 30 ? [...list.slice(0, 30), `- and ${list.length - 30} more`] : list;
  const lines = [
    `Contribution from TMSync: ${n} items. They are too many to fill in here, so TMSync copied them.`,
    "",
    ...shown,
    "",
    "**Paste step:** paste the copied JSON into the block below, in place of the placeholder line, as it is. It is ONE list that holds every item above, recipes and quick links together. Each entry's `kind` says which one it is, so there is nothing to split.",
  ];
  return { url: issueUrl(title, lines, PASTE_HERE), json, paste: true };
}

/**
 * Contribute a set of user-owned recipes and quick links in ONE issue: one site
 * (its movie and tv recipes and its quick link), a hand-picked set, or everything.
 * `site` names the issue when the set is one site.
 */
export function contribute(recipes: Recipe[], links: QuickLinkSite[], site?: string): Contribution {
  const entries = [
    ...recipes.map(recipeEntry),
    ...links.filter((l) => l.source !== "library").map(quicklinkEntry),
  ];
  const n = entries.length;
  const [only] = entries;
  let title: string;
  if (n === 1 && only) {
    const d = only.data as { name?: string };
    title = `Add ${only.kind === "recipe" ? "recipe" : "quick link"}: ${d.name ?? only.id} (${only.id})`;
  } else if (site) {
    title = `Add site: ${site} (${n} items)`;
  } else {
    title = `Contribute ${n} items from TMSync`;
  }
  return build(title, entries);
}
