---
title: Overview
permalink: /
description: "clawpatch is an automated code review tool that maps repos into semantic feature slices, reviews each with AI providers, persists findings, and can land fixes."
---

## Try it

After installation and project initialization ([Quickstart](quickstart.md)), everything is a single command:

```bash
# Map repo into reviewable features
clawpatch map

# Review features in parallel
clawpatch review --limit 3 --jobs 3

# Generate findings report
clawpatch report

# Fix a specific finding
clawpatch fix --finding <id>

# Re-validate after manual edits
clawpatch revalidate --finding <id>
```

`--json` produces stable JSON on stdout. Human progress and warnings go to
stderr so pipes stay parseable.

## What clawpatch does

- **Semantic feature mapping.** Detects npm bins, Next.js routes, React Router routes, Python packages and Flask/FastAPI routes, Ruby/Rails slices, Laravel/PHP slices, Java/Kotlin Gradle modules, Go packages, Rust crates, SwiftPM targets, and common config files as reviewable units.
- **Automated code review.** Reviews features with AI providers (Codex CLI today), persists findings with severity, category, and line locations.
- **Explicit fix workflow.** `clawpatch fix` runs validated patches for one finding at a time, never commits or pushes automatically.
- **Stable state model.** All features, findings, patches live in `.clawpatch/` as JSON, resumable across runs.
- **Safety first.** Review is read-only, fix refuses dirty worktrees, never auto-commits, validates before accepting patches.
- **Multi-language.** JavaScript/TypeScript, Python, Ruby, PHP/Laravel, Java/Kotlin, Go, Rust, and Swift today; more mappers planned.

## Pick your path

- **Trying it.** [Install](install.md) → [Quickstart](quickstart.md). Five minutes from `pnpm add` to your first review.
- **Understanding features.** [Feature Mapping](feature-mapping.md) explains how clawpatch slices repos into reviewable units.
- **Running reviews.** [Code Review](code-review.md) covers provider integration, parallel execution, and finding categories.
- **Fixing findings.** [Patching](patching.md) documents the explicit fix workflow and validation steps.
- **Reading reports.** [Reporting](reporting.md) shows how to generate Markdown reports and filter by severity.
- **Configuring providers.** [Providers](providers.md) lists supported backends and future provider integration plans.

## All features

- [Installation](install.md)
- [Quickstart](quickstart.md)
- [Configuration](configuration.md)
- [Feature Mapping](feature-mapping.md)
- [Code Review](code-review.md)
- [Findings](findings.md)
- [Patching](patching.md)
- [Reporting](reporting.md)
- [Validation](validation.md)
- [Providers](providers.md)
- [Safety](safety.md)
- [E2E with Gitcrawl](e2e-gitcrawl.md)
- [Initialization](initialization.md)

## Project

Active development; the [changelog](https://github.com/openclaw/clawpatch/blob/main/CHANGELOG.md) tracks recent releases. Goals and implementation details in [spec.md](spec.md). Released under the [MIT license](https://github.com/openclaw/clawpatch/blob/main/LICENSE).
