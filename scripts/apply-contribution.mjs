#!/usr/bin/env node
/**
 * Apply a TMSync contribution payload (from a labelled GitHub issue) to the recipe
 * lists, so the workflow can open a ready-to-merge PR. The payload is the
 * self-describing wrapper the extension emits (see lib/portability/contribute.ts):
 *
 *   { kind: "recipe"|"quicklink", tracker: "trakt"|"anilist",
 *     action: "add", id, schemaVersion?, data }
 *
 * Routing: everything lands in the single, tracker-agnostic recipes/index.json —
 * recipes into `recipes[]`, quick links into `links[]`. Each recipe carries its own
 * `tracker` field, so there is no per-tracker file to route to. Add by id; an
 * existing id is an UPDATE (never a silent duplicate). Validation of the recipe
 * SHAPE is left to the repo's existing schema tests in CI — a malformed recipe
 * makes parseLibrary drop it and recipes.test.ts fails, blocking the merge.
 *
 * A single-entry contribution emits a content-keyed branch (`branch` output) so a
 * re-contribution of the same site UPDATES its open PR instead of racing a twin.
 */
import { readFileSync, writeFileSync } from "node:fs";

const RECIPES_INDEX = "recipes/index.json";

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
    const idx = load(RECIPES_INDEX);
    idx.recipes ??= [];
    const at = idx.recipes.findIndex((r) => r.id === e.id);
    if (at >= 0) {
      idx.recipes[at] = e.data;
      summary.push(`- updated recipe \`${e.id}\` in \`${RECIPES_INDEX}\``);
    } else {
      idx.recipes.push(e.data);
      summary.push(`- added recipe \`${e.id}\` to \`${RECIPES_INDEX}\``);
    }
    save(RECIPES_INDEX, idx);
  } else if (e.kind === "quicklink") {
    const idx = load(RECIPES_INDEX);
    idx.links ??= [];
    const at = idx.links.findIndex((l) => l.id === e.id);
    if (at >= 0) {
      idx.links[at] = e.data;
      summary.push(`- updated quick link \`${e.id}\``);
    } else {
      idx.links.push(e.data);
      summary.push(`- added quick link \`${e.id}\``);
    }
    save(RECIPES_INDEX, idx);
  } else {
    summary.push(`- skipped unknown kind \`${e.kind}\``);
  }
}

const text = summary.join("\n") || "- no changes";
console.log(text);

// Content-keyed branch for a single-entry contribution (so re-contributing the same
// site updates its PR instead of racing a duplicate); else fall back to the issue.
const single = entries.length === 1 && entries[0]?.id ? String(entries[0].id) : null;
const slug = single
  ? single
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  : null;
const issueNumber = process.env.ISSUE_NUMBER ?? "unknown";
const branch = slug ? `contribution/${slug}` : `contribution/issue-${issueNumber}`;

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    `summary<<TMSYNC_EOF\n${text}\nTMSYNC_EOF\nbranch=${branch}\n`,
    { flag: "a" },
  );
}
