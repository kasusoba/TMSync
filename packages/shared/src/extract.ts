import type { Field, Recipe } from "./schema";
import { applyTransforms } from "./transforms";
import type { EngineContext, ExtractResult, ParsedMedia } from "./types";

/**
 * The pure recipe-extraction engine.
 *
 * Reads each declared `Field` from the injected document/url, applies the
 * declarative cleaning steps (regex → capture group → transforms), and returns
 * a normalized `ParsedMedia`. Contains ZERO recipe-supplied executable code:
 * recipes are data, never functions. Never throws — failures surface as
 * `{ ok: false }` so the content script can degrade quietly.
 */
export function extract(recipe: Recipe, ctx: EngineContext): ExtractResult {
  if (!recipe.extract) {
    // Manual recipe — there is nothing to scrape. Callers should branch on
    // isManualRecipe() before reaching here; this guard keeps extract() total.
    return { ok: false, error: "manual recipe — pick the title in-page" };
  }

  const title = readField(recipe.extract.title, ctx);
  if (!title) {
    return { ok: false, error: "could not read a title from this page" };
  }

  const year = readInt(recipe.extract.year, ctx);
  const season = readInt(recipe.extract.season, ctx);
  const episode = readInt(recipe.extract.episode, ctx);

  const media: ParsedMedia = {
    mediaType: resolveMediaType(recipe.mediaType, season, episode),
    title,
  };
  if (year !== undefined) media.year = year;
  if (season !== undefined) media.season = season;
  if (episode !== undefined) media.episode = episode;

  return { ok: true, media };
}

/**
 * A manual recipe carries no `extract` — the page has no readable title, so the
 * user picks it in-page (and we remember it by `manualKey`). The content script
 * branches on this instead of calling extract().
 */
export function isManualRecipe(recipe: Recipe): boolean {
  return recipe.extract === undefined;
}

function resolveMediaType(
  declared: Recipe["mediaType"],
  season: number | undefined,
  episode: number | undefined,
): ParsedMedia["mediaType"] {
  if (declared === "movie" || declared === "show") return declared;
  return season !== undefined || episode !== undefined ? "show" : "movie";
}

function readInt(field: Field | undefined, ctx: EngineContext): number | undefined {
  const raw = readField(field, ctx);
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Resolve a single field to a cleaned, non-empty string, or `null` if the
 * value is absent/unreadable. Exported for the element picker (auto-detect +
 * per-field live preview).
 */
export function readField(field: Field | undefined, ctx: EngineContext): string | null {
  if (!field) return null;

  const raw = rawValue(field, ctx);
  if (raw === null) return null;

  const captured = applyRegex(raw, field);
  if (captured === null) return null;

  const cleaned = applyTransforms(captured, field.transforms).trim();
  return cleaned === "" ? null : cleaned;
}

function applyRegex(value: string, field: Field): string | null {
  if (!field.regex) return value;
  let re: RegExp;
  try {
    re = new RegExp(field.regex);
  } catch {
    return null; // malformed regex in a recipe — degrade quietly
  }
  const match = re.exec(value);
  if (!match) return null;
  const group = field.group ?? 1;
  return match[group] ?? null;
}

function rawValue(field: Field, ctx: EngineContext): string | null {
  switch (field.source) {
    case "url":
      return ctx.url;
    case "title":
      return ctx.document.title || null;
    case "meta":
      return readMeta(field, ctx.document);
    case "dom":
      return readDom(field, ctx.document);
    case "jsonld":
      return readJsonLd(field, ctx.document);
  }
}

function readMeta(field: Field, document: Document): string | null {
  if (!field.selector) return null;
  const escaped = cssEscape(field.selector);
  const el = document.querySelector(`meta[property="${escaped}"], meta[name="${escaped}"]`);
  return el?.getAttribute("content") ?? null;
}

function readDom(field: Field, document: Document): string | null {
  if (!field.selector) return null;
  let el: Element | null;
  try {
    el = document.querySelector(field.selector);
  } catch {
    return null; // invalid selector — degrade quietly
  }
  if (!el) return null;
  if (field.attr) return el.getAttribute(field.attr);
  return el.textContent;
}

function readJsonLd(field: Field, document: Document): string | null {
  if (!field.selector) return null;
  for (const node of collectJsonLd(document)) {
    const value = getByPath(node, field.selector);
    const str = stringifyScalar(value);
    if (str !== null) return str;
  }
  return null;
}

/** Parse every <script type="application/ld+json">, flattening arrays + @graph. */
function collectJsonLd(document: Document): unknown[] {
  const out: unknown[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of Array.from(scripts)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    pushNode(out, parsed);
  }
  return out;
}

function pushNode(out: unknown[], node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) pushNode(out, item);
    return;
  }
  if (isRecord(node)) {
    out.push(node);
    const graph = node["@graph"];
    if (Array.isArray(graph)) {
      for (const item of graph) pushNode(out, item);
    }
  }
}

/** Walk a dotted path, descending into arrays by index or by first matching member. */
function getByPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number.parseInt(key, 10);
      if (!Number.isNaN(idx)) {
        cur = cur[idx];
      } else {
        const hit = cur.find((item) => isRecord(item) && key in item);
        cur = isRecord(hit) ? hit[key] : undefined;
      }
    } else if (isRecord(cur)) {
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function stringifyScalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Escape a value for safe interpolation inside a CSS attribute-value selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
