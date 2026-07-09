import { RECIPES } from "@/config";
import type { QuickLinkSite } from "@/lib/storage";
import { type Recipe, recipeTrackers } from "@tmsync/shared";

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
  /** Which tracker(s) this writes to. Kept for display/back-compat; routing to a
   *  file now uses `catalog` (a multi-track anime recipe may be tracker "trakt"). */
  tracker: "trakt" | "anilist";
  /** Which recipe list this belongs in — the CATALOG, not the tracker: "anime" →
   *  recipes/anime/index.json, "mainstream" → recipes/index.json. A recipe is anime
   *  iff it (multi-)tracks to AniList (docs/IDENTITY-NAMESPACES.md). Quick links omit it. */
  catalog?: "mainstream" | "anime";
  /** The client always proposes "add"; the bot/maintainer flips to "update" on an
   *  existing id (and reviews foreign-author updates) — never a silent overwrite. */
  action: "add";
  id: string;
  schemaVersion?: number;
  /** Library-shaped data: local-only fields (enabled/source) already stripped. */
  data: unknown;
}

export interface Contribution {
  url: string;
  /** The raw payload JSON — used as a copy-to-clipboard fallback when `tooLong`. */
  json: string;
  /** GitHub caps the prefilled-issue URL length; past that, copy JSON + open a
   *  blank issue instead. */
  tooLong: boolean;
}

function recipeEntry(r: Recipe): ContributionEntry {
  // Recipes carry no device-local fields beyond the schema, so the recipe IS the
  // library payload. Catalog routes by whether it (multi-)tracks to AniList — an
  // anime site multi-tracked to both Trakt+AniList still belongs in the anime list.
  const anime = recipeTrackers(r).includes("anilist");
  return {
    kind: "recipe",
    tracker: r.tracker ?? "trakt",
    catalog: anime ? "anime" : "mainstream",
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

function build(title: string, entries: ContributionEntry[]): Contribution {
  const json = JSON.stringify(entries.length === 1 ? entries[0] : entries, null, 2);
  const body = [
    "Contribution from TMSync. The JSON below is self-describing (`kind`/`tracker`/`action`/`id`) so it can be routed to the right file and merged with minimal cleanup.",
    "",
    "```json",
    json,
    "```",
  ].join("\n");
  const u = new URL(`${RECIPES.contributeUrl}/issues/new`);
  u.searchParams.set("title", title);
  u.searchParams.set("body", body);
  u.searchParams.set("labels", "contribution");
  const url = u.toString();
  return { url, json, tooLong: url.length > URL_LIMIT };
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
  return build(`Contribute ${entries.length} item(s) from TMSync`, entries);
}

/** Blank new-issue URL — the destination when a payload is too long to prefill. */
export const blankIssueUrl = `${RECIPES.contributeUrl}/issues/new`;
