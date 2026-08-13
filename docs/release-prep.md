---
title: Release Prep
description: "No-publish checks for preparing a clawpatch release"
---

# Release Prep

This checklist audits release readiness only. It does not publish, tag, create a
GitHub release, or change the package version.

## Release Snapshot

Record the target version, current npm version, release commit, local validation,
and CI URLs in the GitHub release notes. Verify the target version is absent from
npm, Git tags, and GitHub releases before publishing.

## Audit Commands

```bash
gh release list --repo openclaw/clawpatch --limit 20 --json tagName,isPrerelease,isDraft,publishedAt,isLatest
node -p "require('./package.json').version"
npm view clawpatch version --json
git tag --list "vX.Y.Z"
gh release view "vX.Y.Z" --repo openclaw/clawpatch
```

## Validation Commands

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm exec vitest run --maxWorkers=1
pnpm build
pnpm pack:smoke
npm pack --dry-run --json --ignore-scripts
```

## Manual Checks

- Confirm npm Trusted Publisher is bound to GitHub repository
  `openclaw/clawpatch`, workflow filename `release.yml`, environment
  `npm-release`, and the `npm publish` action.
- Confirm `CHANGELOG.md` has all user-visible, operational, or security-relevant
  changes under the next unreleased version.
- Confirm README and docs mention any new mapper behavior, commands, or safety
  constraints.
- Confirm the dry-run package includes built `dist/` files and excludes local
  state, fixtures that should not ship, and private paths.
- Publish npm and verify its version, `latest` tag, tarball, integrity, and
  timestamp before creating the GitHub release.
- Confirm no release action has been run unless release timing is explicitly
  approved.
