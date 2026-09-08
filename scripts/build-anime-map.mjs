#!/usr/bin/env node
/**
 * Build `recipes/anime-map.json`, the TMDB<->AniList crosswalk the multi-track
 * fan-out derives episode numbering from (docs/MULTI-TRACK.md).
 *
 * Source: Fribb/anime-lists `anime-list-full.json`, which a bot regenerates every
 * week. The output is a trimmed subset of it: only entries that carry BOTH an
 * AniList id and a TMDB id, and only the five fields the resolver reads. It is
 * served from the same CDN as the recipe list, so a refresh needs no extension
 * release.
 *
 * Row shape (short keys, because every client downloads this file):
 *   a  AniList id
 *   t  TMDB id (always a number; Fribb gives movie ids as an array, so a movie
 *      with several TMDB entries expands to one row per id)
 *   k  "tv" | "movie": which TMDB id namespace (tv and movie ids overlap)
 *   s  TMDB season this AniList entry maps to (tv only, omitted when absent)
 *   o  episodes before this entry within its TMDB season (tv only, omitted when 0)
 *
 * Usage: node scripts/build-anime-map.mjs [--out <path>] [--src <url|file>]
 */
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SRC = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";
const OUT = resolve(import.meta.dirname, "../recipes/anime-map.json");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const src = arg("--src", SRC);
const out = arg("--out", OUT);

/** Read the source list from the CDN, or from a local file when given a path. */
async function readSource(from) {
  if (!/^https?:/.test(from)) return JSON.parse(await readFile(from, "utf8"));
  const res = await fetch(from);
  if (!res.ok) throw new Error(`fetch ${from}: HTTP ${res.status}`);
  return res.json();
}

/** One Fribb entry -> zero or more crosswalk rows. */
function toRows(entry) {
  const a = entry.anilist_id;
  const tmdb = entry.themoviedb_id;
  if (typeof a !== "number" || !tmdb || typeof tmdb !== "object") return [];

  if (typeof tmdb.tv === "number") {
    const season = entry.season?.tmdb;
    const offset = entry.episode_offset?.tmdb;
    const row = { a, t: tmdb.tv, k: "tv" };
    if (typeof season === "number") row.s = season;
    if (typeof offset === "number" && offset !== 0) row.o = offset;
    return [row];
  }

  // Movies: Fribb stores them as an array, and one AniList movie can point at
  // several TMDB entries. Each becomes its own row, so the resolver then treats the
  // reverse direction as ambiguous and refuses rather than picking one.
  const ids = Array.isArray(tmdb.movie) ? tmdb.movie : [tmdb.movie];
  return ids.filter((t) => typeof t === "number").map((t) => ({ a, t, k: "movie" }));
}

const entries = await readSource(src);
if (!Array.isArray(entries)) throw new Error("source is not an array");

const rows = entries.flatMap(toRows);
if (rows.length < 1000) throw new Error(`only ${rows.length} rows, refusing to write`);

const payload = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "Fribb/anime-lists anime-list-full.json",
  rows,
};

writeFileSync(out, `${JSON.stringify(payload)}\n`);

const tv = rows.filter((r) => r.k === "tv").length;
console.log(
  `wrote ${out}: ${rows.length} rows (${tv} tv, ${rows.length - tv} movie) from ${entries.length} entries`,
);
