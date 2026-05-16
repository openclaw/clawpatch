---
title: Specification
description: "Product goals, design, implementation details, and architecture"
---

# clawpatch spec

Automated code review that lands fixes.

`clawpatch` maps a repo into reviewable feature slices, reviews each slice for real bugs and quality gaps, revalidates findings, and turns confirmed issues into repair patches or PRs when explicitly asked.

## Goals

- Review by semantic feature, not file list.
- Persist every run, finding, patch attempt, command, and model decision.
- Resume safely after crashes, quota failures, auth failures, or Ctrl-C.
- Produce strict machine-readable records and terse human output.
- Default to report-only; apply code changes only on explicit `fix`.
- Never overwrite user changes.
- Make small repair patches, usually one finding cluster at a time.
- Revalidate before marking findings fixed.

## Non-goals for v0

- No autonomous repo-wide rewrite.
- No implicit commit, push, PR, or land.
- No file-only scanner as the main product.
- No general-purpose agent shell.
- No provider matrix before one provider path works well.
- No custom database. Start with project-local JSON files.

## Package

- repo: `openclaw/clawpatch`
- npm package: `clawpatch`
- CLI bin: `clawpatch`
- runtime: Node.js
- language: strict TypeScript
- formatter: `oxfmt`
- linter: `oxlint`
- test runner: Vitest unless a better repo-native choice appears before initial scaffold.

## TypeScript/tooling requirements

- TypeScript only. No JS source except generated build output or config files that cannot reasonably be TS.
- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `noImplicitOverride: true`
- `noFallthroughCasesInSwitch: true`
- `noPropertyAccessFromIndexSignature: true`
- ESM package.
- JSON schemas or runtime validators at all external boundaries.
- No `any` except tightly contained adapter boundaries with comments.
- Prefer discriminated unions for state machines.
- Use `unknown` for untrusted data, then parse.
- Fail loud on malformed model/provider JSON.
- Format with `oxfmt`.
- Lint with `oxlint`.
- CI must run typecheck, lint, format check, and tests.

Suggested scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "oxlint .",
    "format": "oxfmt --write .",
    "format:check": "oxfmt --check .",
    "test": "vitest run"
  }
}
```

## CLI contract

Global usage:

```bash
clawpatch [global flags] <command> [command flags]
```

Global flags:

- `-h, --help`: show help, ignore other args.
- `--version`: print version to stdout.
- `--root <path>`: repo root. Default: nearest git root, else cwd.
- `--state-dir <path>`: state directory. Default: `<root>/.clawpatch`.
- `--config <path>`: config path. Default discovery below.
- `--json`: structured JSON to stdout.
- `--plain`: stable line-oriented output to stdout.
- `-q, --quiet`: suppress non-essential human output.
- `-v, --verbose`: more progress detail.
- `--debug`: include debug diagnostics and log path.
- `--no-color`: disable color.
- `--no-input`: never prompt.

Stdout:

- Primary command result.
- JSON when `--json`.
- Stable line output when `--plain`.

Stderr:

- Progress, diagnostics, warnings, and errors.
- No progress spinners when non-TTY.

Exit codes:

- `0`: success.
- `1`: runtime failure.
- `2`: invalid usage or config.
- `3`: dirty worktree blocks requested operation.
- `4`: provider auth/config failure.
- `5`: provider quota/rate-limit failure.
- `6`: tests/validation failed.
- `7`: lock conflict.
- `8`: malformed provider output.

Color:

- Auto only on TTY.
- Disabled by `NO_COLOR`, `TERM=dumb`, or `--no-color`.

Interactivity:

- Prompts only on TTY.
- `--no-input` fails instead of prompting.
- Commands that change code require explicit command intent and may still prompt unless `--yes`.

## Commands

### `clawpatch init`

Create project state and detected config.

Usage:

```bash
clawpatch init [--force] [--no-input]
```

Behavior:

- Finds repo root.
- Creates `.clawpatch/`.
- Detects git remote/default branch.
- Detects languages/frameworks/package manager.
- Detects likely build/test/lint/format commands.
- Writes `.clawpatch/project.json`.
- Writes `.clawpatch/config.json` if missing.
- Does not run model calls.
- Idempotent unless `--force`.

Output:

- Human: created/updated paths and next command.
- JSON: `ProjectRecord`.

### `clawpatch map`

Build or update semantic feature records.

Usage:

```bash
clawpatch map [--dry-run] [--force] [--include <glob>] [--exclude <glob>] [--max-features <n>]
```

Behavior:

- Runs deterministic mappers.
- Expands context via imports/references/tests/docs where cheap.
- Creates/updates `.clawpatch/features/<featureId>.json`.
- Marks removed feature seeds as stale, not deleted.
- Does not call a model in v0 by default.
- Later: `--enrich` may use an agent to improve summaries/tags.

Output:

- Human: feature count, new/changed/stale counts.
- JSON: `MapRunResult`.

### `clawpatch status`

Show current project/review state.

Usage:

```bash
clawpatch status [--json]
```

Behavior:

- Reads state only.
- Shows project, current git branch, dirty status, feature/finding counts, active locks, last run.

### `clawpatch review`

Review feature slices and persist findings.

Usage:

```bash
clawpatch review [--feature <id>] [--kind <kind>] [--limit <n>] [--dry-run] [--provider <name>] [--model <name>] [--resume <runId>]
```

Behavior:

- Claims pending or selected features.
- Assembles bounded prompt context.
- Calls provider.
- Parses strict JSON.
- Writes append-only analysis entry.
- Writes findings.
- Releases locks.
- Does not edit files.
- Resume skips completed features.

Selection:

- Explicit `--feature` wins.
- Else pending/errored features, filtered by `--kind`.
- `--limit` caps claimed features.

### `clawpatch report`

Print or write a findings report.

Usage:

```bash
clawpatch report [--run <runId>] [--severity <level>] [--format markdown|json] [-o <path>]
```

Behavior:

- Reads state only.
- Groups findings by severity, category, feature.
- Includes evidence, confidence, status, and suggested next command.
- Markdown default for humans.
- JSON default under `--json`.

### `clawpatch fix`

Apply repairs for selected findings.

Usage:

```bash
clawpatch fix --finding <id> [--finding <id> ...] [--dry-run] [--yes] [--provider <name>] [--model <name>]
clawpatch fix --feature <id> [--severity high] [--dry-run] [--yes]
```

Behavior:

- Starts with `git status -sb`.
- Refuses dirty worktree unless changes are only prior clawpatch patch files for the same attempt, or future config allows unsafe mode.
- Claims a `PatchAttempt`.
- Builds fix prompt from selected finding cluster and feature context.
- Applies edits only in current worktree.
- Runs targeted format/lint/tests when known.
- Records files changed and command results.
- Marks finding `fixed` only after revalidation succeeds.
- No commit/PR by default.

Safety:

- No destructive git commands.
- No branch switch.
- No overwrite of unrecognized user changes.
- `--dry-run` produces a patch plan only.

### `clawpatch revalidate`

Verify findings or patch attempts.

Usage:

```bash
clawpatch revalidate [--finding <id>] [--patch <id>] [--feature <id>] [--provider <name>] [--model <name>]
```

Behavior:

- Uses separate prompt pass and configured commands.
- Confirms whether evidence still exists.
- Updates finding status:
  - `fixed`
  - `open`
  - `false-positive`
  - `uncertain`
- Records test/lint/build output summaries.

### `clawpatch triage`

Deduplicate and prioritize findings.

Usage:

```bash
clawpatch triage [--run <runId>] [--dry-run]
```

Behavior:

- Groups duplicate signatures.
- Merges equivalent findings with shared evidence.
- Re-ranks by severity, confidence, reachability, test coverage, and patchability.
- No code edits.

May be post-v0 if review output is already clean enough.

### `clawpatch open-pr`

Create or update a repair PR.

Usage:

```bash
clawpatch open-pr --patch <id> [--draft] [--base <branch>]
```

Behavior:

- Requires existing patch attempt with changed files.
- Requires clean validation state unless `--force`.
- Creates branch/commit/PR only after explicit command.
- Uses repo-native commit helper if configured.
- PR body includes findings, tests, revalidation, and links to state report.

Post-v0.

### `clawpatch land`

Land an existing clawpatch PR.

Usage:

```bash
clawpatch land --pr <number>
```

Behavior:

- Checks CI/revalidation state.
- Merges only when explicit.
- Follows host/repo policy.

Post-v0.

### `clawpatch doctor`

Check environment.

Usage:

```bash
clawpatch doctor [--json]
```

Behavior:

- Checks Node version, package install, git, repo root, state dir, provider config, known command availability.
- Checks exact provider env names only.
- Never prints secret values.

### `clawpatch clean-locks`

Clear stale locks.

Usage:

```bash
clawpatch clean-locks [--older-than <duration>] [--dry-run] [--yes]
```

Behavior:

- Lists locks older than threshold.
- Clears only stale claim metadata.
- Does not delete analysis/finding/patch data.

## Config

Discovery order:

- `--config <path>`
- `<root>/clawpatch.config.json`
- `<root>/.clawpatch/config.json`
- future: user config under XDG

Precedence:

- flags
- env
- project config
- defaults

Initial config:

```json
{
  "schemaVersion": 1,
  "stateDir": ".clawpatch",
  "include": ["**/*"],
  "exclude": [
    "node_modules/**",
    "dist/**",
    "build/**",
    "target/**",
    ".build/**",
    ".git/**",
    ".clawpatch/**"
  ],
  "provider": {
    "name": "openai",
    "model": "gpt-5.2"
  },
  "commands": {
    "typecheck": null,
    "lint": null,
    "format": null,
    "test": null
  },
  "review": {
    "maxContextFiles": 24,
    "maxOwnedFiles": 12,
    "maxFindingsPerFeature": 10,
    "minConfidenceToFix": "medium"
  },
  "git": {
    "requireCleanWorktreeForFix": true,
    "commit": false,
    "openPr": false
  }
}
```

Env:

- `CLAWPATCH_CONFIG`
- `CLAWPATCH_STATE_DIR`
- `CLAWPATCH_PROVIDER`
- `CLAWPATCH_MODEL`
- provider-specific exact env names, checked by provider adapters

Secrets:

- Never accepted as CLI flags.
- Never printed.
- Doctor reports present/missing/redacted only.

## State layout

Initial project-local layout:

```text
.clawpatch/
  config.json
  project.json
  features/
    <featureId>.json
  findings/
    <findingId>.json
  runs/
    <runId>.json
  patches/
    <patchAttemptId>.json
  reports/
    <runId>.md
  locks/
    <lockId>.json
```

Recommended `.gitignore` entry:

```gitignore
.clawpatch/runs/
.clawpatch/findings/
.clawpatch/patches/
.clawpatch/reports/
.clawpatch/locks/
```

Open question:

- Whether `.clawpatch/project.json` and `.clawpatch/features/*.json` should be checked in by default. v0 should not force either.

## Record IDs

- `projectId`: slug from repo remote/root plus stable hash.
- `featureId`: deterministic slug from kind + entrypoint path/symbol.
- `findingId`: hash of category + normalized evidence + title.
- `runId`: timestamp + short random suffix.
- `patchAttemptId`: timestamp + finding hash prefix.

IDs must be stable enough for reruns and short enough for CLI usage.

## Schemas

### `ProjectRecord`

```ts
type ProjectRecord = {
  schemaVersion: 1;
  projectId: string;
  name: string;
  rootPath: string;
  git: {
    remoteUrl: string | null;
    defaultBranch: string | null;
    currentBranch: string | null;
    headSha: string | null;
  };
  detected: {
    languages: string[];
    frameworks: string[];
    packageManagers: string[];
    commands: ProjectCommands;
  };
  createdAt: string;
  updatedAt: string;
};
```

### `FeatureRecord`

```ts
type FeatureRecord = {
  schemaVersion: 1;
  featureId: string;
  title: string;
  summary: string;
  kind: FeatureKind;
  source: FeatureSource;
  confidence: "high" | "medium" | "low";
  entrypoints: FeatureEntrypoint[];
  ownedFiles: FeatureFileRef[];
  contextFiles: FeatureFileRef[];
  tests: FeatureTestRef[];
  tags: string[];
  trustBoundaries: TrustBoundary[];
  status: FeatureStatus;
  lock: FeatureLock | null;
  findingIds: string[];
  patchAttemptIds: string[];
  analysisHistory: AnalysisEntry[];
  createdAt: string;
  updatedAt: string;
};
```

Kinds:

- `cli-command`
- `route`
- `ui-flow`
- `service`
- `job`
- `agent-tool`
- `library`
- `config`
- `release`
- `test-suite`
- `infra`
- `unknown`

Statuses:

- `pending`
- `claimed`
- `reviewed`
- `needs-fix`
- `fixing`
- `fixed`
- `revalidated`
- `skipped`
- `error`

Trust boundaries:

- `user-input`
- `network`
- `filesystem`
- `secrets`
- `process-exec`
- `database`
- `auth`
- `permissions`
- `concurrency`
- `external-api`
- `serialization`

### `FindingRecord`

```ts
type FindingRecord = {
  schemaVersion: 1;
  findingId: string;
  featureId: string;
  title: string;
  category: FindingCategory;
  severity: "critical" | "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  evidence: EvidenceRef[];
  reasoning: string;
  reproduction: string | null;
  recommendation: string;
  status: "open" | "false-positive" | "fixed" | "wont-fix" | "uncertain";
  signature: string;
  linkedPatchAttemptIds: string[];
  createdByRunId: string;
  createdAt: string;
  updatedAt: string;
};
```

Categories:

- `bug`
- `security`
- `performance`
- `concurrency`
- `api-contract`
- `data-loss`
- `test-gap`
- `docs-gap`
- `build-release`
- `maintainability`

Evidence refs:

```ts
type EvidenceRef = {
  path: string;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
  quote: string | null;
};
```

### `PatchAttempt`

```ts
type PatchAttempt = {
  schemaVersion: 1;
  patchAttemptId: string;
  findingIds: string[];
  featureIds: string[];
  status: "planned" | "applying" | "applied" | "validated" | "failed" | "abandoned";
  plan: string;
  filesChanged: string[];
  commandsRun: CommandResult[];
  testResults: CommandResult[];
  provider: ProviderMetadata | null;
  git: {
    baseSha: string | null;
    commitSha: string | null;
    branchName: string | null;
    prUrl: string | null;
  };
  createdAt: string;
  updatedAt: string;
};
```

### `RunRecord`

```ts
type RunRecord = {
  schemaVersion: 1;
  runId: string;
  command: string;
  args: string[];
  rootPath: string;
  headSha: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  claimedFeatureIds: string[];
  findingIds: string[];
  patchAttemptIds: string[];
  errors: RunError[];
};
```

## Mapping

Mapping must be deterministic first.

Mappers:

- Node package bins from `package.json`.
- Node scripts from `package.json`.
- Node workspace and Nx project metadata as project roots for framework mappers.
- TypeScript/JavaScript CLI command registries when cheap to detect.
- Next.js `app/**/page.*`, `app/**/route.*`, `pages/**` at the repo root or inside discovered project roots.
- Express/Fastify/Hono route registrations.
- Go `cmd/*` commands and `internal/*` packages.
- Rust Cargo commands, libraries, workspace crates, and integration tests.
- SwiftPM executable targets, library targets, and test suites.
- Test suites from common test file globs.
- Config/release features from package/build/release files.
- Shared infra from auth/session/db/process/fs/network/secrets files.

Later mappers:

- Go HTTP handlers.
- Rust Clap command trees.
- Python Click/Typer/argparse/FastAPI.

Feature expansion:

- Owned files are entrypoint and direct implementation files.
- Context files are imports, referenced shared modules, nearby tests, docs, configs.
- Shared files can be context for many features.
- Shared files also get their own `infra` or `library` feature when important.
- Context caps must be explicit and recorded.

Feature source examples:

- `package-json-bin`
- `package-json-script`
- `next-app-route`
- `next-pages-route`
- `express-route`
- `test-glob`
- `shared-infra-heuristic`
- `manual`
- `agent-enriched`

## Review pipeline

Stages:

1. Load project/config/state.
2. Select features.
3. Claim locks.
4. Assemble prompt context.
5. Call provider.
6. Parse strict JSON.
7. Normalize/dedupe finding signatures.
8. Persist findings and analysis entries.
9. Release locks.
10. Write run summary.

Review categories:

- correctness bugs
- security issues
- race/concurrency bugs
- data loss/corruption
- resource leaks
- bad error handling
- permission/auth gaps
- API contract mismatches
- missing/weak tests
- release/build hazards
- maintainability risks with concrete impact

Review output schema:

```ts
type ReviewOutput = {
  findings: Array<{
    title: string;
    category: FindingCategory;
    severity: "critical" | "high" | "medium" | "low";
    confidence: "high" | "medium" | "low";
    evidence: EvidenceRef[];
    reasoning: string;
    reproduction: string | null;
    recommendation: string;
  }>;
  inspected: {
    files: string[];
    symbols: string[];
    notes: string[];
  };
};
```

Rules:

- Empty findings are valid only as `{"findings":[],"inspected":...}`.
- Markdown wrappers around JSON are invalid.
- Missing required fields are invalid.
- Evidence must reference files in owned/context files unless explicitly marked external.
- Findings do not need diff overlap.

## Prompt assembly

Prompt includes:

- product instruction
- project summary
- feature summary
- kind/source/confidence
- entrypoints
- trust boundaries
- owned file contents
- context file excerpts
- relevant tests/docs/configs
- command hints
- strict JSON schema
- review categories
- instruction to avoid speculative low-evidence findings

Context priorities:

1. Entrypoints.
2. Owned implementation files.
3. Nearby tests.
4. Direct imports.
5. Trust-boundary files.
6. Docs/config relevant to behavior.

Prompt must record:

- files included
- files omitted due to budget
- token/size estimates where available

## Fix pipeline

Stages:

1. Validate requested findings.
2. Check worktree safety.
3. Claim patch attempt.
4. Build fix plan.
5. Apply patch.
6. Run formatter/linter/typecheck/tests.
7. Persist command results.
8. Revalidate.
9. Update finding/patch status.
10. Report next action.

Patch principles:

- Smallest correct change.
- Prefer tests for bugs when feasible.
- Match repo style.
- Do not add dependencies without explicit approval.
- Do not silence errors without fixing root cause.
- Do not broaden scope to nearby refactors.

Fix output schema:

```ts
type FixPlanOutput = {
  summary: string;
  findingIds: string[];
  plannedFiles: string[];
  risk: "low" | "medium" | "high";
  steps: string[];
  validationCommands: string[];
};
```

## Revalidation

Revalidation inputs:

- original finding
- evidence
- patch diff if any
- command results
- relevant current files

Outcomes:

- `fixed`: issue no longer present and validation supports fix.
- `open`: issue still present.
- `false-positive`: original finding invalid.
- `uncertain`: insufficient evidence.

Revalidation must not mark fixed from model opinion alone when targeted commands fail.

## Provider adapters

Initial provider:

- OpenAI or Codex-backed adapter, whichever is simplest at implementation time.

Adapter contract:

```ts
type ProviderAdapter = {
  name: string;
  check(): Promise<ProviderCheckResult>;
  review(input: ReviewProviderInput): Promise<ReviewProviderResult>;
  planFix(input: FixProviderInput): Promise<FixProviderResult>;
  revalidate(input: RevalidateProviderInput): Promise<RevalidateProviderResult>;
};
```

Provider errors:

- auth
- quota
- rate-limit
- transient
- malformed-output
- unsupported
- unknown

Provider metadata:

- provider name
- model
- request id if available
- token usage if available
- cost estimate if available
- started/finished timestamps

## Git safety

Every mutating command starts with git state.

Rules:

- No destructive git commands.
- No branch switch unless command explicitly requires it and user confirms.
- No commit unless command explicitly asks.
- No push unless command explicitly asks.
- No PR unless command explicitly asks.
- Refuse fix on dirty worktree by default.
- Preserve user changes.
- Record base SHA for each patch attempt.

Dirty worktree behavior:

- `review`: allowed.
- `map`: allowed, but records dirty state.
- `fix`: refused unless configured/confirmed.
- `open-pr`: refused unless clean validation state.

## Test command selection

Detection sources:

- package manager scripts
- known test config files
- feature test refs
- language/framework conventions

Command order for fixes:

1. formatter on changed files when supported
2. targeted tests
3. lint/typecheck
4. broader tests when cheap or explicitly requested

Command results store:

- command
- cwd
- exit code
- duration
- stdout/stderr excerpts
- full log path when large

## Locking

Feature lock:

- `lockedByRunId`
- `lockedAt`
- `hostname`
- `pid`

Claim behavior:

- Atomic write where possible.
- Existing fresh lock blocks.
- Stale locks require `clean-locks` or age threshold.
- Crashes leave recoverable locks.

## Reports

Markdown report sections:

- run summary
- project summary
- counts by severity/category/status
- high-confidence findings
- uncertain findings
- skipped/error features
- patch attempts
- recommended next commands

Report findings include:

- title
- severity/confidence/category
- feature
- evidence
- reasoning
- recommendation
- status

## Output examples

Init:

```text
created: .clawpatch/project.json
created: .clawpatch/config.json
detected: typescript, node, pnpm
next: clawpatch map
```

Map:

```text
features: 18
new: 18
changed: 0
stale: 0
next: clawpatch review --limit 3
```

Review:

```text
run: 20260515-104455-a13f
reviewed: 3
findings: 5
high: 1
medium: 3
low: 1
report: .clawpatch/reports/20260515-104455-a13f.md
next: clawpatch fix --finding fnd_abc123
```

## Testing requirements

Unit tests:

- config discovery/precedence
- project detection
- package manager detection
- feature ID stability
- Node bin/script mapper
- Next route mapper
- test file association
- import/context expansion caps
- state read/write validation
- malformed JSON state failures
- lock claim/release/stale lock behavior
- strict provider JSON parse failures
- duplicate finding signatures
- patch attempt transitions
- command selection

Fixture repos:

- `fixtures/node-cli`
- `fixtures/next-app`
- `fixtures/express-api`

Snapshot tests:

- prompt assembly
- markdown report
- human status output
- JSON output schema examples

## Initial repo skeleton

Expected v0 files:

```text
README.md
LICENSE
package.json
tsconfig.json
oxlint.json
src/
  cli.ts
  commands/
    init.ts
    map.ts
    status.ts
    report.ts
  config/
  state/
  mapper/
  provider/
  review/
  fix/
  git/
  tests/
docs/
  spec.md
  architecture.md
fixtures/
  node-cli/
  next-app/
```

## Release criteria for v0.1

- npm package installs and exposes `clawpatch`.
- `clawpatch init` writes valid state.
- `clawpatch map` finds features in fixture repos and clawpatch itself.
- `clawpatch status --json` stable and tested.
- `clawpatch report` works with sample findings.
- Strict TypeScript passes.
- `oxlint` passes.
- `oxfmt --check .` passes.
- Tests pass in CI.
- README explains current limits honestly.

## Open questions

- First provider path: direct OpenAI Responses API vs Codex task integration.
- Check in feature map by default or keep all generated state ignored.
- Exact command parser library.
- Exact runtime minimum Node version.
- Whether review should support concurrent feature claims in v0.1 or wait until v0.2.
- Whether `fix` should create a temporary branch by default in a later release.
