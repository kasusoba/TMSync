# Releasing

For maintainers. The steps, from a merged change to a published release:

```bash
git checkout main && git pull
pnpm release minor      # or major / patch / an explicit 1.10.0
git push --follow-tags
```

A bug fix is a patch. A new capability is a minor. `pnpm release` bumps
`packages/extension/package.json`, commits it as `chore(release): vX.Y.Z`, and tags that commit.
Pushing the tag runs `.github/workflows/release.yml`, which re-runs the CI checks, builds the
Chrome, Firefox, and sources zips, and attaches them to a **draft** GitHub Release whose notes are
generated from the PRs merged since the last tag. When that run finishes, publish:

```bash
gh release edit vX.Y.Z --title vX.Y.Z --draft=false --latest
```

Do not leave the release as a draft.

## Release notes

Notes are generated, not written. Keep GitHub's `## What's Changed` list and its
`**Full Changelog**` link. Edit only to drop noise (a revert pair, a chore nobody sees) or to fix
a PR title that reads badly. Do not add install, usage, or contributor sections. A good PR title
is what makes this work, so spend the effort there.

The release title is the version and nothing else: `v1.10.2`.

## Merging PRs

Never commit to `main`. Merge with `gh pr merge --squash --delete-branch`, then
`git checkout main && git pull`. Always squash-merge: one PR is one commit on `main`, with the PR
title as its subject. The detailed commits stay on the PR page.

## Store uploads and secrets

- Uploading to the Chrome Web Store and AMO stays manual.
- The workflow needs the `WXT_*` OAuth ids and secrets as repository secrets (see
  `packages/extension/.env.example`). It fails early rather than ship a build that cannot sign in.
  MyAnimeList and Simkl need only a client id. AniList needs a second id and secret for Firefox.

## Calling off a release

The version in `packages/extension/package.json` is the version being *prepared*, and the tag is
the decision to *ship* it. Tag when you want a release, not every time something lands. To call
one off before it goes out, delete the draft and its tag
(`gh release delete vX.Y.Z --yes --cleanup-tag`), keep working on the same prepared version, and
tag the final commit when you are ready:

```bash
git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
```

Only ever delete a tag whose release was never published. Once it is out, supersede it with a new
version instead.

## Automation

- **Crosswalk** (`.github/workflows/anime-map.yml`): rebuilds `recipes/anime-map.json` from the
  upstream Fribb list every Monday and opens a PR. It needs Settings, then Actions, then "Allow
  GitHub Actions to create and approve pull requests". Run `pnpm anime-map` to rebuild it by hand.
