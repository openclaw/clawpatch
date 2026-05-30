---
name: release-clawpatch
description: "clawpatch release: version/changelog, CI, npm publish, GitHub release, verify."
---

# Clawpatch Release

## Scope

Release `~/Projects/clawpatch` as the public npm package `clawpatch`.

Use `$npm` and `$one-password` rules for registry auth. Keep all `op` and npm secret work inside one persistent tmux session and temp npmrc. Never print tokens, passwords, or OTPs.

## Workflow

1. Start clean on `main`.
   - `cd ~/Projects/clawpatch`
   - `git status --short --branch`
   - `git pull --ff-only`
   - Confirm target version is not already tagged or released: `git tag --list "vX.Y.Z"` and `gh release view vX.Y.Z --repo openclaw/clawpatch`.
   - Confirm npm state: `npm view clawpatch version dist-tags time --json`.

2. Prep release files.
   - Set `package.json` version to target.
   - Change top changelog section from `Unreleased` to `X.Y.Z - YYYY-MM-DD`.
   - Ensure release notes are the changelog body for that version and include all user-facing changes.
   - Run `pnpm install --lockfile-only`; commit lockfile only if it actually changes.

3. Prove locally before publishing.
   - Run `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build && pnpm pack:smoke`.
   - Fix failures before continuing.

4. Commit and push release prep.
   - Commit with `committer "chore(release): X.Y.Z" CHANGELOG.md package.json [pnpm-lock.yaml]`.
   - `git push origin main`.
   - Watch CI/CodeQL for the release commit:
     - `gh run list --repo openclaw/clawpatch --branch main --commit <sha> --json databaseId,workflowName,status,conclusion,url,headSha`
     - `gh run view <run_id> --repo openclaw/clawpatch --json status,conclusion,url,jobs`
   - Do not publish until release-commit CI and CodeQL are green.

5. Publish npm.
   - Use a temp npmrc, never the default user npmrc.
   - First try `npm whoami`; if unauthenticated, use npm web login in the tmux session:
     - `NPM_CONFIG_USERCONFIG="$tmp_npmrc" npm login --auth-type=web --registry=https://registry.npmjs.org/`
     - Open/approve browser login if prompted.
   - For publish, fetch a fresh OTP from the `npmjs` 1Password item inside the same tmux session.
   - Publish with `NPM_CONFIG_USERCONFIG="$tmp_npmrc" npm publish --access public --otp "$NPM_OTP"`.
   - Clean temp npmrc/work dirs after publish.
   - If publish says the version already exists, verify npm metadata and continue only if it matches the release commit/package contents.

6. Verify npm before GitHub release.
   - `npm view clawpatch@X.Y.Z version dist-tags dist.tarball dist.integrity time --json`
   - Required: version is `X.Y.Z`, `latest` points to `X.Y.Z`, tarball URL exists, integrity exists, publish time exists.

7. Tag and create GitHub release.
   - Build release notes from changelog plus npm/proof:
     - npm version page
     - registry tarball
     - integrity string
     - CI and CodeQL run URLs
     - local proof command
   - Use temp files for public GitHub bodies.
   - `git tag -a vX.Y.Z <release_sha> -m "vX.Y.Z"`
   - `git push origin vX.Y.Z`
   - `gh release create vX.Y.Z --repo openclaw/clawpatch --title "vX.Y.Z" --notes-file "$notes"`

8. Release verify.
   - `npm view clawpatch@X.Y.Z version dist-tags.latest dist.tarball dist.integrity time.X.Y.Z --json`
   - `gh release view vX.Y.Z --repo openclaw/clawpatch --json tagName,url,body,isDraft,isPrerelease`
   - Confirm release body contains changelog notes, npm version link, tarball, integrity, and CI/proof.
   - Confirm tag points at the release commit: `git rev-list -n1 vX.Y.Z`.

9. Post-release closeout.
   - Add next patch section at top of `CHANGELOG.md`: `## X.Y.(Z+1) - Unreleased`.
   - Commit with `committer "docs(changelog): open X.Y.(Z+1)" CHANGELOG.md`.
   - Push `main`.
   - Watch closeout CI until green.
   - Final: `git checkout main && git pull --ff-only && git status --short --branch`.

## Notes

- Do not create the GitHub release before npm publish is verified; the release body must include npm proof.
- If npm auth scripts fail, keep the same tmux session. Do not start a second secret session unless the first is unusable.
- Avoid broad secret inspection. Query exact `npmjs` fields only.
- Public `gh` comments/releases should use temp `--body-file` / `--notes-file`, not inline quoted bodies.
