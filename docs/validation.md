---
title: Validation and Revalidation
description: "Validation commands during fix workflow and revalidation process"
---

# Validation and Revalidation

Validation happens during `clawpatch fix`.

Configured commands run in order:

- configured format command
- feature-specific test commands
- configured typecheck command
- configured lint command
- configured test command

Duplicate commands run once. A mapper may suppress the configured test fallback
for a feature when it identifies an unsuitable task, such as a persistent Turbo
task. Validation commands have a ten-minute default timeout, configurable through
`CLAWPATCH_VALIDATION_TIMEOUT_MS`.

Commands are detected during `clawpatch init` or configured in
`.clawpatch/config.json`.

Example:

```json
{
  "commands": {
    "format": "pnpm format",
    "lint": "pnpm lint",
    "typecheck": "pnpm typecheck",
    "test": "pnpm test"
  }
}
```

`clawpatch revalidate --finding <id>` runs a separate provider pass and updates
the finding status based on that result. `clawpatch revalidate --all` rechecks a
filtered queue and records one history entry per finding.

Current limitations:

- no `--skip-*` validation flags
- no targeted test command generation per finding
- no parallel batch revalidation
