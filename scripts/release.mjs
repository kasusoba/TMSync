#!/usr/bin/env node
/**
 * Cut a release: bump the extension's version, commit it, and tag it, in one step.
 *
 *   pnpm release 1.10.0     explicit version
 *   pnpm release minor      bump from the current version (major | minor | patch)
 *
 * The bump and the tag used to be separate manual acts, so they could drift: a
 * `chore(release)` commit with no tag, or a tag pointing at the wrong commit. Here
 * they are one operation, and the release workflow (.github/workflows/release.yml)
 * refuses to publish a tag whose version does not match the manifest anyway.
 *
 * Nothing is pushed. Review, then:
 *
 *   git push --follow-tags
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PKG = "packages/extension/package.json";
const RELEASE_BRANCH = "main";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail("usage: pnpm release <major|minor|patch|x.y.z>");

// The working tree has to be clean: the release commit carries the version bump
// and nothing else, so a stray edit would be silently released with it.
if (git("status", "--porcelain") !== "") fail("working tree is not clean; commit or stash first");

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== RELEASE_BRANCH)
  fail(`on branch "${branch}"; releases are cut from ${RELEASE_BRANCH}`);

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const current = pkg.version;
const parts = current.split(".").map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN))
  fail(`cannot parse current version "${current}"`);
const [major, minor, patch] = parts;

const next =
  arg === "major"
    ? `${major + 1}.0.0`
    : arg === "minor"
      ? `${major}.${minor + 1}.0`
      : arg === "patch"
        ? `${major}.${minor}.${patch + 1}`
        : arg;

if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`"${next}" is not a valid version (expected x.y.z)`);
if (next === current) fail(`already at ${current}`);

const tag = `v${next}`;
if (git("tag", "--list", tag) !== "") fail(`tag ${tag} already exists`);

pkg.version = next;
writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);

git("add", PKG);
git("commit", "-m", `chore(release): ${tag}`);
git("tag", "-a", tag, "-m", tag);

console.log(`✓ ${current} → ${next}, committed and tagged ${tag}`);
console.log("  next: git push --follow-tags");
