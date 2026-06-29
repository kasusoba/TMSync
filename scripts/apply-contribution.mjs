#!/usr/bin/env node
/**
 * Apply a TMSync contribution payload (from a labelled GitHub issue) to the recipe
 * lists, so the workflow can open a ready-to-merge PR. The payload is the
 * self-describing wrapper the extension emits (see lib/portability/contribute.ts):
 *
 *   { kind: "recipe"|"quicklink", tracker: "trakt"|"anilist",
 *     action: "add", id, schemaVersion?, data }
 *
 * Routing: recipe+trakt → recipes/index.json (recipes[]); recipe+anilist →
 * recipes/anime/index.json (recipes[]); quicklink → recipes/index.json (links[]).
 * Add by id; an existing id is an UPDATE (never a silent duplicate). Validation of
 * the recipe SHAPE is left to the repo's existing schema tests in CI — a malformed
 * recipe makes parseLibrary drop it and recipes.test.ts fails, blocking the merge.
 */
import { readFileSync, writeFileSync } from "node:fs";

const TRAKT_INDEX = "recipes/index.json";
const ANIME_INDEX = "recipes/anime/index.json";

const body = process.env.ISSUE_BODY ?? "";
const block = body.match(/```json\s*([\s\S]*?)```/i);
if (!block) {
  console.log("No JSON payload block found — nothing to apply.");
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(block[1]);
} catch (e) {
  console.error("Payload is not valid JSON:", e.message);
  process.exit(1);
}
const entries = Array.isArray(payload) ? payload : [payload];

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const save = (p, o) => writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`);

const summary = [];
for (const e of entries) {
  if (!e || typeof e !== "object" || !e.id || !e.kind || e.data == null) {
    summary.push("- skipped an invalid entry");
    continue;
  }
  if (e.kind === "recipe") {
    const path = e.tracker === "anilist" ? ANIME_INDEX : TRAKT_INDEX;
    const idx = load(path);
    idx.recipes ??= [];
    const at = idx.recipes.findIndex((r) => r.id === e.id);
    if (at >= 0) {
      idx.recipes[at] = e.data;
      summary.push(`- updated recipe \`${e.id}\` in \`${path}\``);
    } else {
      idx.recipes.push(e.data);
      summary.push(`- added recipe \`${e.id}\` to \`${path}\``);
    }
    save(path, idx);
  } else if (e.kind === "quicklink") {
    const idx = load(TRAKT_INDEX);
    idx.links ??= [];
    const at = idx.links.findIndex((l) => l.id === e.id);
    if (at >= 0) {
      idx.links[at] = e.data;
      summary.push(`- updated quick link \`${e.id}\``);
    } else {
      idx.links.push(e.data);
      summary.push(`- added quick link \`${e.id}\``);
    }
    save(TRAKT_INDEX, idx);
  } else {
    summary.push(`- skipped unknown kind \`${e.kind}\``);
  }
}

const text = summary.join("\n") || "- no changes";
console.log(text);
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `summary<<TMSYNC_EOF\n${text}\nTMSYNC_EOF\n`, {
    flag: "a",
  });
}
