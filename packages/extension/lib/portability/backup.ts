import {
  type BadgePrefs,
  type QuickLinkSite,
  badgePrefs,
  corrections,
  customRecipes,
  forkBases,
  listSyncSettings,
  manualSelections,
  quickLinks,
  quickLinksEnabled,
  recipeSources,
  siteSourcePins,
} from "@/lib/storage";
import type { ListSyncSettings } from "@/lib/sync/types";
import type { ResolvedIdentity } from "@/lib/trackers/trakt/types";
import type { ParsedMedia, Recipe } from "@tmsync/shared";
import { LinkTemplates, RecipeSchema, TrackerId } from "@tmsync/shared";
import { z } from "zod";

/**
 * Manual backup (export/import). The bundle is exactly the **sync layer** — the
 * user-owned deltas (custom recipes, recipe source URLs and site picks, user quick
 * links + source link toggles, corrections, manual picks, badge prefs), and
 * explicitly NOT source content (re-fetched from each source), tokens, or caches. See docs/ARCHITECTURE.md: the export
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
  ids: z
    .record(z.enum(["tmdb", "imdb", "tvdb", "anilist", "mal"]), z.union([z.string(), z.number()]))
    .optional(),
});

const QuickLinkSiteSchema = LinkTemplates.extend({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  tracker: z.enum(["trakt", "anilist"]).optional(),
  // "library" is the old name of a link from the central list, read as "user".
  source: z.enum(["library", "user", "source"]).optional(),
});

const RecipeSourceSchema = z.object({
  id: z.string(),
  // https only, like the Add field in Options.
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://")),
  enabled: z.boolean(),
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

// Objects, not records: a tracker or kind a newer build added is dropped, and the
// rest of the backup still imports.
const SyncKindSchema = z.enum(["movie", "tv", "anime"]);
const ListSyncSettingsSchema: z.ZodType<ListSyncSettings> = z.object({
  kinds: z.object({
    trakt: z.array(SyncKindSchema).optional(),
    anilist: z.array(SyncKindSchema).optional(),
    mal: z.array(SyncKindSchema).optional(),
    simkl: z.array(SyncKindSchema).optional(),
    wetrakr: z.array(SyncKindSchema).optional(),
  }),
  includePrivate: z.boolean(),
  includeAdult: z.boolean(),
  ignore: z.array(z.string()),
  main: z
    .object({
      movie: TrackerId.optional(),
      tv: TrackerId.optional(),
      anime: TrackerId.optional(),
    })
    .optional(),
  auto: z.boolean().optional(),
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
    sourceLinkToggles: z.record(z.string(), z.boolean()).default({}),
    // Validated per item at apply time, so one bad source never sinks the import.
    recipeSources: z.array(z.unknown()).default([]),
    siteSourcePins: z.record(z.string(), z.string()).default({}),
    forkBases: z
      .record(z.string(), z.object({ sourceId: z.string(), hash: z.string() }))
      .default({}),
    corrections: z.record(z.string(), ResolvedIdentitySchema).default({}),
    manualSelections: z.record(z.string(), ParsedMediaSchema).default({}),
    badgePrefs: BadgePrefsSchema.optional(),
    quickLinksEnabled: z.boolean().optional(),
    listSync: ListSyncSettingsSchema.optional(),
  }),
});

export type Backup = z.infer<typeof BackupSchema>;

export interface ImportSummary {
  recipes: number;
  /** Recipe sources this device did not have yet. */
  sources: number;
  quickLinks: number;
  corrections: number;
  manualSelections: number;
  badgePrefs: boolean;
  /** Recipes dropped because they failed schema validation. */
  skippedRecipes: number;
}

/** Gather the user-owned deltas into a versioned, downloadable bundle. */
export async function buildBackup(): Promise<Backup> {
  const [recipes, links, corr, manual, badge, linksOn, listSync, sources, pins, bases] =
    await Promise.all([
      customRecipes.getValue(),
      quickLinks.getValue(),
      corrections.getValue(),
      manualSelections.getValue(),
      badgePrefs.getValue(),
      quickLinksEnabled.getValue(),
      listSyncSettings.getValue(),
      recipeSources.getValue(),
      siteSourcePins.getValue(),
      forkBases.getValue(),
    ]);
  // Source quick links come from their source on every device, so carry only
  // their on/off toggle, not the templates.
  const userQuickLinks = links.filter((l) => l.source !== "source");
  const sourceLinkToggles: Record<string, boolean> = {};
  for (const l of links) if (l.source === "source") sourceLinkToggles[l.id] = l.enabled;
  // Automatic sync is per device: two browsers running it would each send the same
  // Trakt plays. So it stays out of the backup.
  const { auto: _device, ...listSyncPrefs } = listSync;
  return {
    app: "tmsync",
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    data: {
      customRecipes: recipes,
      userQuickLinks,
      sourceLinkToggles,
      recipeSources: sources,
      siteSourcePins: pins,
      forkBases: bases,
      corrections: corr,
      manualSelections: manual,
      badgePrefs: badge,
      quickLinksEnabled: linksOn,
      listSync: listSyncPrefs,
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

  // Recipe sources: add the ones this device lacks (same URL = same source), after
  // its own, so the restore does not reorder what is here. Sites picks and fork
  // bases follow, imported wins on key.
  // A source this device already has (by URL) may carry another id here, so
  // picks and fork bases are moved onto this device's id.
  const haveSources = await recipeSources.getValue();
  const idHere = new Map<string, string>();
  const newSources: z.infer<typeof RecipeSourceSchema>[] = [];
  const validSources = d.recipeSources.flatMap((raw) => {
    const res = RecipeSourceSchema.safeParse(raw);
    return res.success ? [res.data] : [];
  });
  for (const s of validSources) {
    const same = haveSources.find((h) => h.url === s.url);
    if (same) idHere.set(s.id, same.id);
    else if (haveSources.some((h) => h.id === s.id)) {
      const id = crypto.randomUUID();
      idHere.set(s.id, id);
      newSources.push({ ...s, id });
    } else {
      idHere.set(s.id, s.id);
      newSources.push(s);
    }
  }
  const mapId = (id: string) => idHere.get(id) ?? id;
  if (newSources.length) await recipeSources.setValue([...haveSources, ...newSources]);
  const pins = Object.fromEntries(
    Object.entries(d.siteSourcePins).map(([host, id]) => [host, mapId(id)]),
  );
  await siteSourcePins.setValue({ ...(await siteSourcePins.getValue()), ...pins });
  const bases = Object.fromEntries(
    Object.entries(d.forkBases).map(([rid, b]) => [rid, { ...b, sourceId: mapId(b.sourceId) }]),
  );
  await forkBases.setValue({ ...(await forkBases.getValue()), ...bases });

  // Quick links: merge user links by id; apply source link toggles to existing rows.
  const linkMap = new Map<string, QuickLinkSite>(
    (await quickLinks.getValue()).map((l) => [l.id, l]),
  );
  for (const { source: _old, ...l } of d.userQuickLinks)
    linkMap.set(l.id, { ...l, source: "user" });
  for (const [id, enabled] of Object.entries(d.sourceLinkToggles)) {
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
  if (d.quickLinksEnabled !== undefined) await quickLinksEnabled.setValue(d.quickLinksEnabled);
  // Automatic sync stays as this device has it, even when an older backup
  // carries `auto`.
  if (d.listSync)
    await listSyncSettings.setValue({
      ...d.listSync,
      auto: (await listSyncSettings.getValue()).auto,
    });

  return {
    recipes: validRecipes.length,
    sources: newSources.length,
    quickLinks: d.userQuickLinks.length,
    corrections: Object.keys(d.corrections).length,
    manualSelections: Object.keys(d.manualSelections).length,
    badgePrefs: !!d.badgePrefs,
    skippedRecipes,
  };
}
