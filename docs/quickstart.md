---
title: Quickstart
description: "Get started with clawpatch in five minutes"
---

# Quickstart

This guide walks through a complete review workflow from initialization to fixing findings.

## Prerequisites

- [Install clawpatch](install.md)
- Install Codex CLI: `brew install codex`
- Have a project with code to review

## 1. Initialize

```bash
cd your-project
clawpatch init
```

This creates `.clawpatch/` with:

- `config.json` - project configuration
- `project.json` - detected project metadata
- `features/` - feature records (created by `map`)
- `findings/` - review findings (created by `review`)
- `patches/` - patch attempts (created by `fix`)

Check project detection:

```bash
clawpatch status
```

## 2. Map features

```bash
clawpatch map
```

This discovers reviewable features:

- npm package bins and root/workspace scripts
- Next.js routes
- Go packages and commands
- Java/Kotlin Gradle modules
- Python packages, console scripts, Flask/FastAPI routes, and pytest suites
- JVM semantic role groups
- Ruby packages, Rails apps, executables, and tests
- Rust crates and binaries
- SwiftPM targets and tests
- Laravel controllers, requests, jobs, commands, services, models, migrations, and tests
- Config files

Preview mapping without writing:

```bash
clawpatch map --dry-run
```

Check mapped features:

```bash
clawpatch status --json | jq '.features'
```

## 3. Review

Review a few features in parallel:

```bash
clawpatch review --limit 3 --jobs 3
```

This:

- Selects 3 pending features
- Reviews them in parallel with 3 workers
- Calls the provider (Codex CLI) for each
- Persists findings under `.clawpatch/findings/`
- Updates feature status

Progress goes to stderr, so you can pipe stdout:

```bash
clawpatch review --limit 5 --json | jq '.findings'
```

## 4. Generate report

```bash
clawpatch report
```

Filter by severity:

```bash
clawpatch report --severity high
```

Save to file:

```bash
clawpatch report -o report.md
```

## 5. Fix a finding

List findings:

```bash
clawpatch report --status open
```

Fix one:

```bash
clawpatch fix --finding <findingId>
```

This:

- Validates worktree is clean
- Calls provider with patch instructions
- Runs validation commands
- Records patch attempt
- Shows diff

Review the changes and commit manually if satisfied.

## 6. Revalidate

After manual edits or to re-check a finding:

```bash
clawpatch revalidate --finding <findingId>
```

## Common workflows

### Review entire project

```bash
clawpatch review --limit 999 --jobs 4
```

### Review specific feature

```bash
clawpatch review --feature <featureId>
```

### Review with different model

```bash
clawpatch review --model claude-opus-4-20250514 --limit 5
```

### Filter report by category

```bash
clawpatch report --category security
```

### Check provider status

```bash
clawpatch doctor
```

### Clean stale locks

If a review run was interrupted:

```bash
clawpatch clean-locks
```

## Output formats

All commands support `--json` for machine-readable output:

```bash
clawpatch map --json
clawpatch review --json
clawpatch status --json
```

## Next steps

- [Feature Mapping](feature-mapping.md) - How features are discovered
- [Code Review](code-review.md) - Review process details
- [Patching](patching.md) - Fix workflow explained
- [Configuration](configuration.md) - Customize behavior
- [Providers](providers.md) - Provider options
