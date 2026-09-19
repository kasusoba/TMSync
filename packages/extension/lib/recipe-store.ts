import { type Recipe, RecipeSchema } from "@tmsync/shared";
import { browser } from "wxt/browser";

/**
 * The user's own recipes, one `browser.storage.sync` key per recipe
 * (`recipe:{id}`, docs/STORAGE-SYNC.md). Sync allows 8 KB per key, so the old
 * single `custom_recipes` list stopped saving at about 13 recipes. Same
 * getValue/setValue/watch shape as a WXT storage item.
 *
 * Every read parses each recipe with the schema (constraint #8): another device
 * can write a recipe this build doesn't understand. A recipe that fails is skipped.
 */

const KEY = "recipe:";
/** The old single-key list. Read until the first write moves it to per-recipe keys. */
const LEGACY = "custom_recipes";
/** WXT's version metadata for the old item. */
const LEGACY_META = "custom_recipes$";

/** `at` keeps the list order: a recipe keeps its place when it is edited. */
interface Stored {
  at: number;
  recipe: Recipe;
}

type Area = Record<string, unknown>;

const sync = () => browser.storage.sync;
const isRecipeKey = (k: string) => k.startsWith(KEY) || k === LEGACY;

function parse(raw: unknown): Recipe | null {
  const res = RecipeSchema.safeParse(raw);
  return res.success ? res.data : null;
}

function read(area: Area): Recipe[] {
  const rows: Stored[] = [];
  for (const [key, value] of Object.entries(area)) {
    if (!key.startsWith(KEY)) continue;
    const v = value as Partial<Stored> | undefined;
    const recipe = parse(v?.recipe);
    if (recipe) rows.push({ at: typeof v?.at === "number" ? v.at : 0, recipe });
  }
  rows.sort((a, b) => a.at - b.at);
  const out = rows.map((r) => r.recipe);
  const ids = new Set(out.map((r) => r.id));
  const legacy = area[LEGACY];
  if (Array.isArray(legacy)) {
    for (const raw of legacy) {
      const recipe = parse(raw);
      if (recipe && !ids.has(recipe.id)) out.push(recipe);
    }
  }
  return out;
}

async function getValue(): Promise<Recipe[]> {
  return read(await sync().get(null));
}

/** Write the list: set the recipes that changed, then remove the ones that are gone
 * (and the old single key). A recipe over the 8 KB key limit throws the browser's
 * quota error, so the caller can report it. */
async function setValue(list: Recipe[]): Promise<void> {
  const area = await sync().get(null);
  const now = Date.now();
  const writes: Area = {};
  const keep = new Set<string>();
  list.forEach((recipe, i) => {
    const key = `${KEY}${recipe.id}`;
    keep.add(key);
    const old = area[key] as Partial<Stored> | undefined;
    const next: Stored = { at: typeof old?.at === "number" ? old.at : now + i, recipe };
    if (JSON.stringify(old) !== JSON.stringify(next)) writes[key] = next;
  });
  if (Object.keys(writes).length) await sync().set(writes);
  const gone = Object.keys(area).filter(
    (k) => (k.startsWith(KEY) && !keep.has(k)) || k === LEGACY || k === LEGACY_META,
  );
  if (gone.length) await sync().remove(gone);
}

/** Call `cb` with the new and the old list when any recipe key changes. */
function watch(cb: (next: Recipe[], prev: Recipe[]) => void): () => void {
  const listener = async (
    changes: Record<string, { oldValue?: unknown }>,
    areaName: string,
  ): Promise<void> => {
    if (areaName !== "sync") return;
    const keys = Object.keys(changes).filter(isRecipeKey);
    if (!keys.length) return;
    const area = await sync().get(null);
    const before: Area = { ...area };
    for (const k of keys) {
      const old = changes[k]?.oldValue;
      if (old === undefined) delete before[k];
      else before[k] = old;
    }
    cb(read(area), read(before));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Move the old single-key list to per-recipe keys. Safe to run in every context. */
async function migrate(): Promise<void> {
  const area = await sync().get([LEGACY, LEGACY_META]);
  if (area[LEGACY] === undefined && area[LEGACY_META] === undefined) return;
  await setValue(await getValue());
}

export const customRecipes = { getValue, setValue, watch, migrate };
