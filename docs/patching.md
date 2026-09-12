---
title: Patching
description: "Explicit fix workflow for individual findings"
---

# Patching

`clawpatch fix` is explicit and finding-scoped.

```bash
clawpatch fix --finding <findingId>
```

Current behavior:

- reads the selected finding
- checks the worktree is clean outside `.clawpatch/` when configured
- creates a patch attempt record
- asks the provider for a fix plan
- lets the provider edit the worktree during the explicit fix command
- runs the configured formatter, feature-specific tests, typecheck, lint, and
  configured test command, with duplicates removed (see [Validation](validation.md))
- records command results
- links the patch attempt to the finding

Status updates:

- validation success marks the finding `uncertain`
- validation failure keeps the finding `open`

The CLI does not currently mark a finding `fixed` from the patch pass alone.
Use `clawpatch revalidate --finding <id>` for a second pass.

## Opening a PR

After reviewing the applied worktree changes, create a GitHub PR explicitly:

```bash
clawpatch open-pr --patch <patchAttemptId> --draft
```

`open-pr` requires an applied or validated patch attempt with recorded changed
files. It refuses failed validation unless `--force` is passed, commits only the
recorded patch files, pushes the branch, and calls the GitHub CLI. Use
`--dry-run` to preview the branch, title, body, and commands without touching
git.

Not implemented yet:

- fixing by severity or category
- batching multiple findings
- auto-commit
- rollback snapshots
