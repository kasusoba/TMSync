import { RECIPES } from "@/config";
import type { QuickLinkSite } from "@/lib/storage";
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
  tracker: "trakt" | "anilist";
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

const PASTE_HERE = "Replace this line with the JSON that TMSync copied for you (paste it).";

function issueUrl(title: string, lead: string, block: string): string {
  const body = [
    lead,
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
  const url = issueUrl(title, "Contribution from TMSync. Submit this issue as it is.", json);
  if (url.length <= URL_LIMIT) return { url, json, paste: false };
  // Too long to prefill: the same issue, with a paste step for the JSON.
  const lead = "Contribution from TMSync. Paste the JSON into the block below, then submit.";
  return { url: issueUrl(title, lead, PASTE_HERE), json, paste: true };
}

export function contributeRecipe(r: Recipe): Contribution {
  return build(`Add recipe: ${r.name} (${r.id})`, [recipeEntry(r)]);
}

export function contributeQuickLink(s: QuickLinkSite): Contribution {
  return build(`Add quick link: ${s.name} (${s.id})`, [quicklinkEntry(s)]);
}

/** Contribute every user-owned recipe + quick link at once. */
export function contributeAll(recipes: Recipe[], links: QuickLinkSite[]): Contribution {
  const entries = [
    ...recipes.map(recipeEntry),
    ...links.filter((l) => l.source !== "library").map(quicklinkEntry),
  ];
  const n = entries.length;
  return build(`Contribute ${n} ${n === 1 ? "item" : "items"} from TMSync`, entries);
}
