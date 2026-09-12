---
title: Specification
description: "Implemented workflow, state model, and architecture"
---

# Clawpatch architecture

Clawpatch maps repositories into bounded semantic features, reviews them through
installed coding harnesses, and records findings for explicit repair and
revalidation. [VISION.md](../VISION.md) defines the product boundary: harnesses
own model transport, authentication, and execution.

This document describes the implemented architecture. Use `clawpatch --help`
and `clawpatch <command> --help` for accepted flags; the focused guides below
cover command behavior and configuration. Runtime record schemas live in
[`src/types.ts`](https://github.com/openclaw/clawpatch/blob/main/src/types.ts),
so this page does not maintain a second set of schema definitions.

## Command workflow

| Command                  | Responsibility                                                                   | Guide                                    |
| ------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------- |
| `init`                   | Detect the project and create local state/configuration.                         | [Initialization](initialization.md)      |
| `map`                    | Discover deterministic features, optionally augmented by an agent.               | [Feature mapping](feature-mapping.md)    |
| `review`                 | Claim selected features, review bounded context, and persist validated findings. | [Code review](code-review.md)            |
| `ci`                     | Initialize if needed, map, review, and report in one source-read-only command.   | [Code review](code-review.md#ci-command) |
| `status`                 | Summarize project state, findings, runs, and locks.                              | [Quickstart](quickstart.md)              |
| `next`, `show`, `triage` | Prioritize, inspect, or explicitly change a finding's status.                    | [Findings](findings.md)                  |
| `report`                 | Render filtered findings as Markdown or JSON.                                    | [Reporting](reporting.md)                |
| `fix`                    | Attempt one explicit finding repair and run validation.                          | [Patching](patching.md)                  |
| `revalidate`             | Ask a separate provider pass to reassess findings and record history.            | [Validation](validation.md)              |
| `open-pr`                | Commit recorded patch files, push a branch, and create a GitHub PR.              | [Patching](patching.md#opening-a-pr)     |
| `doctor`                 | Check the selected harness and report its version/configuration.                 | [Providers](providers.md)                |
| `clean-locks`            | Clear locks; `--stale-only` preserves live local and remote claims.              | [Safety](safety.md)                      |

Commands support JSON results on stdout. Human progress is written to stderr;
`--quiet` suppresses progress. The default command is `status`.

## Source ownership

`src/cli.ts` owns argument validation, dispatch, help, and output formatting.
`src/app.ts` coordinates initialization, mapping, status, CI, and environment
checks. Review, repair, revalidation, finding commands, and PR creation have
separate command modules. Shared configuration loading and run construction
live in `app-context.ts` and `command-support.ts`.

`detect.ts` identifies languages, frameworks, package managers, and conservative
validation commands. `mapper.ts` runs the language mappers under `src/mappers/`,
normalizes seeds into stable feature records, and reconciles previous state.
Mapper context caches share repository inventories and project discovery within
one map run. `agent-mapper.ts` decides when provider-assisted mapping is useful
and validates its returned paths.

`prompt.ts` assembles bounded owned files, context, tests, and metadata. Review
manifests record included and omitted files, truncation, prompt bytes, and
approximate tokens. `review-validation.ts` checks findings against the actual
included evidence. Optional HTTP relations and public-npm claim verification
have separate modules and remain opt-in.

Provider adapters under `src/providers/` translate these inputs into harness
commands. Shared provider modules handle schemas, output parsing, errors,
versions, and timeouts. Adapters retain their harness-specific permission and
authentication boundaries; see [Providers](providers.md).

## State and identity

The default state directory is `.clawpatch/`; [Configuration](configuration.md)
describes overrides and precedence.

```text
.clawpatch/
  config.json
  project.json
  features/<featureId>.json
  findings/<findingId>.json
  runs/<runId>.json
  patches/<patchAttemptId>.json
  reports/<runId>.md
  locks/<featureId>.json
```

State reads validate JSON with Zod. Writes use temporary files and atomic rename.
Feature mutations use per-feature locks; claims also record the run, hostname,
and PID. Dead same-host claims can be reclaimed without clearing another
machine's locks.

Feature IDs derive from mapper identity, rather than mutable descriptions.
Finding signatures include feature, category, title, and canonically ordered
evidence. Re-review preserves existing finding status, history, and patch links.
Triage and revalidation append history entries. Mapping retires missing seeds
without deleting their historical findings.

## Execution and safety

Review uses a bounded worker pool and an optional rolling provider-start rate
limit. Provider output is schema-checked, and invalid individual findings are
dropped while valid siblings survive. Evidence must match files included in the
prompt. Runs retain non-fatal schema/evidence drops as diagnostics.

`fix` requires a finding ID and normally a clean source worktree. A successful
patch pass marks the finding uncertain; revalidation is a separate command.
Validation runs the configured formatter, feature-specific tests, typecheck,
lint, and configured test command, with duplicate commands removed.

`open-pr` is the explicit commit/push boundary. It checks recorded patch files
and validation, preserves its recorded base/commit across retries, and invokes
the GitHub CLI. Clawpatch does not merge PRs or provide automatic rollback.
Provider restrictions vary; [Safety](safety.md) describes their limits.

## Development and verification

Use Node.js 22 or newer and the pnpm version pinned in `package.json`. Source is
strict ESM TypeScript, checked with TypeScript and Oxlint and formatted with
Oxfmt. Tests live beside their modules and use Vitest; mapper behavior is grouped
by language and framework.

Run the commands in [README development](../README.md#development) before
submitting changes. `pnpm pack:smoke` builds and installs a local package, then
runs its CLI against a synthetic mixed-language project. It does not publish.
[Release prep](release-prep.md) covers the separate release workflow.
