---
title: Safety
description: "Safety rules and constraints in clawpatch"
---

# Safety

Current safety rules:

- `review`, `status`, `report`, `doctor`, and `map --dry-run` do not edit source
  files.
- `fix` requires explicit `--finding <id>`.
- `fix` refuses a dirty source worktree by default.
- `.clawpatch/` state changes are allowed during runs.
- review and revalidate provider calls use a read-only sandbox.
- provider output must pass runtime schema validation.
- feature locks are stored in feature records and `.clawpatch/locks/`; `status`
  surfaces both, and `clean-locks` clears both.
- the mapper skips symlinked directories and common generated directories.

Not implemented today:

- automatic commits
- automatic PRs
- automatic landing
- rollback snapshots
- global process locks

Git safety remains the caller's responsibility after a fix. Inspect `git diff`
and run project tests before committing.
