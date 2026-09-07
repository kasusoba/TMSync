import { type EngineContext, type Field, type Transform, collectJsonLd } from "@tmsync/shared";
import {
  type DraftFieldKey,
  pickSeparator,
  queryParamRegex,
  segmentRegex,
  splitNumbers,
  splitSegments,
  urlTokenRegex,
} from "./recipe-builder";

/**
 * THE UNIFORM SOURCE PALETTE.
 *
 * Every draft field can be filled from every source the engine can read: the
 * URL, the page <title>, a player iframe's src, a meta tag, a JSON-LD path, or a
 * clicked page element. The engine never restricted this (extract() reads any
 * `source` for any field). Only the picker UI did, offering title segments
 * for the Title alone and frame URLs for Season/Episode alone. This module
 * removes that asymmetry: it discovers what the page exposes and turns each
 * readable value into ready-to-commit `Field`s, one per clickable chip.
 *
 * The only thing that varies per field is the SHAPE it wants:
 *   • "number" (year/season/episode/ids) → chips are the numbers in the value
 *   • "text"   (title, remember-by key)  → chips are the delimited segments
 * so a source offers what can plausibly answer the field, and nothing else.
 */

/** What kind of value a field wants. Decides the chips and the transforms. */
export type FieldShape = "text" | "number";

/** A rendered piece of a source's value: inert filler, or a clickable value. */
export type Chip =
  | { kind: "lit"; text: string }
  | { kind: "pick"; id: string; text: string; title?: string };

/** One readable value inside a source (a meta tag, one iframe, the URL itself). */
export interface SourceEntry {
  /** Shown before the chips when a source has many values (meta name, JSON-LD path). */
  key?: string;
  chips: Chip[];
}

/** A group of readable values sharing one `Field.source`. */
export interface PickSource {
  id: string;
  label: string;
  entries: SourceEntry[];
}

/** The palette plus the `Field` each chip commits to, keyed by chip id. */
export interface SourcePalette {
  sources: PickSource[];
  fields: Map<string, Field>;
}

export interface PaletteOptions {
  /** Build a CSS selector for an element (the picker injects @medv/finder). */
  selectorFor: (el: Element) => string | undefined;
}

/** Fields other than the title hold a number; the title (and the manual
 * remember-by key) holds text. Drives chips + transforms, nothing else. */
export function shapeOf(fieldKey: DraftFieldKey | "manualKey"): FieldShape {
  return fieldKey === "title" || fieldKey === "manualKey" ? "text" : "number";
}

/** Transforms for a committed text value. A URL/slug segment ("breaking-bad") is
 * de-slugged so it can actually resolve on a tracker; a normal title is left
 * alone (so "Spider-Man" keeps its hyphen). */
export function textTransforms(value: string): Transform[] {
  return looksSlug(value) ? ["trim", "deslugify", "collapseSpaces"] : ["trim", "collapseSpaces"];
}

/** All-lowercase, hyphen/underscore joined, no spaces: a URL slug. */
export function looksSlug(value: string): boolean {
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(value.trim());
}

/** Display cap for a chip label, since a JSON-LD description can be enormous. */
const MAX_LABEL = 48;
/** Per-source entry cap, so a metadata-heavy page can't flood the panel. */
const MAX_ENTRIES = 30;
/** JSON-LD nests deeply; paths past this are noise, not identity. */
const MAX_JSONLD_DEPTH = 3;
/** Player-frame cap: beyond a handful, none of them is the player. */
const MAX_FRAMES = 4;

function ellipsis(value: string): string {
  return value.length > MAX_LABEL ? `${value.slice(0, MAX_LABEL - 1)}…` : value;
}

/** A readable value before it is turned into chips. */
interface RawEntry {
  key?: string;
  /** Where to read it: source + selector + attr. Regex/transforms are per chip. */
  base: Field;
  raw: string;
}

/**
 * Build the palette for the field currently being picked. Sources that expose
 * nothing usable for this shape are dropped, so the panel only ever shows places
 * the value could actually come from.
 */
export function buildPalette(
  ctx: EngineContext,
  shape: FieldShape,
  opts: PaletteOptions,
): SourcePalette {
  const fields = new Map<string, Field>();
  const groups: { id: string; label: string; entries: RawEntry[] }[] = [
    { id: "url", label: "URL", entries: urlEntries(ctx) },
    { id: "title", label: "Page title", entries: titleEntries(ctx) },
    { id: "frame", label: "Player frame URL", entries: frameEntries(ctx, opts) },
    { id: "meta", label: "Meta tag", entries: metaEntries(ctx) },
    { id: "jsonld", label: "JSON-LD", entries: jsonLdEntries(ctx) },
  ];

  const sources: PickSource[] = [];
  for (const group of groups) {
    const entries: SourceEntry[] = [];
    group.entries.slice(0, MAX_ENTRIES).forEach((entry, i) => {
      const chips = chipsFor(entry, shape, `${group.id}:${i}`, fields);
      // A source with no clickable chip (no numbers when a number is wanted) is
      // dropped rather than shown as dead text.
      if (chips.some((c) => c.kind === "pick")) entries.push({ key: entry.key, chips });
    });
    if (entries.length) sources.push({ id: group.id, label: group.label, entries });
  }
  return { sources, fields };
}

/** Turn one readable value into chips, registering the Field each commits to. */
function chipsFor(
  entry: RawEntry,
  shape: FieldShape,
  idPrefix: string,
  fields: Map<string, Field>,
): Chip[] {
  return shape === "number"
    ? numberChips(entry, idPrefix, fields)
    : textChips(entry, idPrefix, fields);
}

/** Number chips: every digit run, committed by ordinal, or by query-param NAME
 * when the value sits in a query string, which survives an id number appearing
 * earlier in the URL and shifting every ordinal. */
function numberChips(entry: RawEntry, idPrefix: string, fields: Map<string, Field>): Chip[] {
  return splitNumbers(entry.raw).map<Chip>((part) => {
    if (!("num" in part)) return { kind: "lit", text: part.text };
    const id = `${idPrefix}:n${part.ordinal}`;
    fields.set(id, {
      ...entry.base,
      regex: part.paramKey ? queryParamRegex(part.paramKey) : urlTokenRegex(part.ordinal),
      group: 1,
      transforms: ["toInt"],
    });
    return {
      kind: "pick",
      id,
      text: part.num,
      title: part.paramKey ? `${part.paramKey}=${part.num}` : undefined,
    };
  });
}

/** Text chips: the value split on its delimiter ("/" for a URL, "|" / " - " for a
 * page title). A value with no delimiter is one chip: the whole string. */
function textChips(entry: RawEntry, idPrefix: string, fields: Map<string, Field>): Chip[] {
  const separator = pickSeparator(entry.raw);
  const segments = splitSegments(entry.raw, separator);
  if (segments.length <= 1) {
    const only = segments[0]?.text ?? entry.raw.trim();
    if (!only) return [];
    const id = `${idPrefix}:whole`;
    fields.set(id, { ...entry.base, transforms: textTransforms(only) });
    return [{ kind: "pick", id, text: ellipsis(only), title: only }];
  }
  const chips: Chip[] = [];
  segments.forEach((segment, i) => {
    if (i > 0) chips.push({ kind: "lit", text: separator });
    const id = `${idPrefix}:s${segment.index}`;
    fields.set(id, {
      ...entry.base,
      regex: segmentRegex(separator, segment.index),
      group: 1,
      transforms: textTransforms(segment.text),
    });
    chips.push({ kind: "pick", id, text: ellipsis(segment.text), title: segment.text });
  });
  return chips;
}

function urlEntries(ctx: EngineContext): RawEntry[] {
  return ctx.url ? [{ base: { source: "url" }, raw: ctx.url }] : [];
}

function titleEntries(ctx: EngineContext): RawEntry[] {
  const raw = ctx.document.title;
  return raw ? [{ base: { source: "title" }, raw }] : [];
}

/**
 * Cross-origin player iframes: the season/episode (and sometimes the id) live in
 * the embed's src, which the top frame CAN read even though the player UI inside
 * is unreachable. Read as a `dom` field on the `src` attribute, so it re-reads
 * live at scrobble time rather than being frozen at pick time.
 */
function frameEntries(ctx: EngineContext, opts: PaletteOptions): RawEntry[] {
  let pageOrigin: string | undefined;
  try {
    pageOrigin = new URL(ctx.url).origin;
  } catch {
    pageOrigin = undefined;
  }
  const out: RawEntry[] = [];
  for (const frame of Array.from(ctx.document.querySelectorAll("iframe"))) {
    const raw = frame.getAttribute("src");
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw, ctx.url);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    // Same-origin frames are almost never the embedded player, just noise.
    if (pageOrigin && url.origin === pageOrigin) continue;
    const selector = opts.selectorFor(frame);
    if (!selector) continue;
    out.push({ key: url.hostname, base: { source: "dom", selector, attr: "src" }, raw });
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

/** Every non-empty meta tag, og:/twitter: first (they carry the real metadata). */
function metaEntries(ctx: EngineContext): RawEntry[] {
  const seen = new Map<string, string>();
  for (const el of Array.from(ctx.document.querySelectorAll("meta"))) {
    const key = el.getAttribute("property") ?? el.getAttribute("name");
    const value = el.getAttribute("content")?.trim();
    if (!key || !value || seen.has(key)) continue;
    seen.set(key, value);
  }
  return Array.from(seen)
    .sort(([a], [b]) => metaRank(a) - metaRank(b))
    .map(([key, raw]) => ({ key, base: { source: "meta" as const, selector: key }, raw }));
}

function metaRank(key: string): number {
  if (key.startsWith("og:")) return 0;
  if (key.startsWith("twitter:")) return 1;
  return 2;
}

/** Every scalar in the page's JSON-LD, keyed by the dotted path the engine reads.
 * Uses the engine's own node flattening, so a picked path is guaranteed readable. */
function jsonLdEntries(ctx: EngineContext): RawEntry[] {
  const seen = new Map<string, string>();
  for (const node of collectJsonLd(ctx.document)) walkJsonLd(node, "", seen, 0);
  return Array.from(seen).map(([path, raw]) => ({
    key: path,
    base: { source: "jsonld" as const, selector: path },
    raw,
  }));
}

function walkJsonLd(node: unknown, prefix: string, out: Map<string, string>, depth: number): void {
  if (depth > MAX_JSONLD_DEPTH || out.size >= MAX_ENTRIES) return;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith("@")) continue; // @type/@context are structure, not values
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text && !out.has(path)) out.set(path, text);
    } else {
      walkJsonLd(value, path, out, depth + 1);
    }
  }
}
