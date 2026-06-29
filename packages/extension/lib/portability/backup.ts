import {
  type BadgePrefs,
  type QuickLinkSite,
  badgePrefs,
  corrections,
  customRecipes,
  manualSelections,
  quickLinks,
} from "@/lib/storage";
import type { ResolvedIdentity } from "@/lib/trakt/types";
import type { ParsedMedia, Recipe } from "@tmsync/shared";
import { LinkTemplates, RecipeSchema } from "@tmsync/shared";
import { z } from "zod";

/**
 * Manual backup (export/import). The bundle is exactly the **sync layer** — the
 * user-owned deltas (custom recipes, user quick links + library toggles,
 * corrections, manual picks, badge prefs) — and explicitly NOT library content
 * (re-fetched from the repo), tokens, or caches. See STORAGE-SYNC.md: the export
 * bundle === the sync payload === "your stuff", so both portability paths move the
 * same set.
 *
 * Note this is the *personal* transfer (your device → your device): corrections +
 * manual picks ARE included here. They are watch-revealing, so they are excluded
 * only from public CONTRIBUTION, never from your own backup.
 */
export const BACKUP_VERSION = 1;

const ResolvedIdentitySchema: z.ZodType<ResolvedIdentity> = z.object({
  mediaType: z.enum(["movie", "show"]),
  traktId: z.number(),
  title: z.string(),
  year: z.number().optional(),
});

const ParsedMediaSchema: z.ZodType<ParsedMedia> = z.object({
  mediaType: z.enum(["movie", "show"]),
  title: z.string(),
  year: z.number().optional(),
  season: z.number().optional(),
  episode: z.number().optional(),
  tmdbId: z.number().optional(),
});

const QuickLinkSiteSchema = LinkTemplates.extend({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  tracker: z.enum(["trakt", "anilist"]).optional(),
  source: z.enum(["library", "user"]).optional(),
});

const BadgePrefsSchema: z.ZodType<BadgePrefs> = z.object({
  mode: z.enum(["full", "dot", "off"]),
  position: z
    .object({
      edge: z.enum(["left", "right", "top", "bottom"]),
      offset: z.number(),
    })
    .nullable(),
});

const BackupSchema = z.object({
  app: z.literal("tmsync"),
  version: z.number(),
  exportedAt: z.number(),
  data: z.object({
    // Validated per-item with RecipeSchema at apply time so one bad recipe never
    // sinks the whole import — kept loose here.
    customRecipes: z.array(z.unknown()).default([]),
    userQuickLinks: z.array(QuickLinkSiteSchema).default([]),
    libraryLinkToggles: z.record(z.string(), z.boolean()).default({}),
    corrections: z.record(z.string(), ResolvedIdentitySchema).default({}),
    manualSelections: z.record(z.string(), ParsedMediaSchema).default({}),
    badgePrefs: BadgePrefsSchema.optional(),
  }),
});

export type Backup = z.infer<typeof BackupSchema>;

export interface ImportSummary {
  recipes: number;
  quickLinks: number;
  corrections: number;
  manualSelections: number;
  badgePrefs: boolean;
  /** Recipes dropped because they failed schema validation. */
  skippedRecipes: number;
}

/** Gather the user-owned deltas into a versioned, downloadable bundle. */
export async function buildBackup(): Promise<Backup> {
  const [recipes, links, corr, manual, badge] = await Promise.all([
    customRecipes.getValue(),
    quickLinks.getValue(),
    corrections.getValue(),
    manualSelections.getValue(),
    badgePrefs.getValue(),
  ]);
  // Library quick links come from the repo on every device — carry only their
  // on/off toggle, not the templates.
  const userQuickLinks = links.filter((l) => l.source !== "library");
  const libraryLinkToggles: Record<string, boolean> = {};
  for (const l of links) if (l.source === "library") libraryLinkToggles[l.id] = l.enabled;
  return {
    app: "tmsync",
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    data: {
      customRecipes: recipes,
      userQuickLinks,
      libraryLinkToggles,
      corrections: corr,
      manualSelections: manual,
      badgePrefs: badge,
    },
  };
}

/** Validate an untrusted parsed JSON value as a Backup, or null if it isn't one. */
export function parseBackup(raw: unknown): Backup | null {
  const res = BackupSchema.safeParse(raw);
  return res.success ? res.data : null;
}

/**
 * Merge a backup into this device. Imported items win on id/key collision (it's a
 * deliberate restore), but nothing is removed — a restore only adds/updates.
 */
export async function applyBackup(backup: Backup): Promise<ImportSummary> {
  const d = backup.data;

  // Recipes: validate each (skip invalid), then merge by id.
  const validRecipes: Recipe[] = [];
  let skippedRecipes = 0;
  for (const r of d.customRecipes) {
    const res = RecipeSchema.safeParse(r);
    if (res.success) validRecipes.push(res.data);
    else skippedRecipes++;
  }
  const recipeMap = new Map((await customRecipes.getValue()).map((r) => [r.id, r]));
  for (const r of validRecipes) recipeMap.set(r.id, r);
  await customRecipes.setValue([...recipeMap.values()]);

  // Quick links: merge user links by id; apply library toggles to existing rows.
  const linkMap = new Map<string, QuickLinkSite>(
    (await quickLinks.getValue()).map((l) => [l.id, l]),
  );
  for (const l of d.userQuickLinks) linkMap.set(l.id, { ...l, source: l.source ?? "user" });
  for (const [id, enabled] of Object.entries(d.libraryLinkToggles)) {
    const ex = linkMap.get(id);
    if (ex) linkMap.set(id, { ...ex, enabled });
  }
  await quickLinks.setValue([...linkMap.values()]);

  // Corrections + manual picks: shallow-merge, imported wins on key.
  await corrections.setValue({ ...(await corrections.getValue()), ...d.corrections });
  await manualSelections.setValue({
    ...(await manualSelections.getValue()),
    ...d.manualSelections,
  });

  if (d.badgePrefs) await badgePrefs.setValue(d.badgePrefs);

  return {
    recipes: validRecipes.length,
    quickLinks: d.userQuickLinks.length,
    corrections: Object.keys(d.corrections).length,
    manualSelections: Object.keys(d.manualSelections).length,
    badgePrefs: !!d.badgePrefs,
    skippedRecipes,
  };
}
