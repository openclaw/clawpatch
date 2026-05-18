# 🩹 clawpatch

Automated code review that lands fixes.

`clawpatch` maps a repo into semantic feature slices, reviews each slice with a
provider, persists findings, and can run an explicit fix loop for one finding at
a time.

Current status: early CLI. Review/report/state are implemented; patching exists
behind `clawpatch fix --finding <id>` and still requires manual review of the
resulting worktree changes.

## Install

```bash
pnpm add -g clawpatch
```

From source:

```bash
pnpm install
pnpm build
pnpm link --global
```

## Workflow

```bash
clawpatch init
clawpatch map
clawpatch review --limit 3 --jobs 3
clawpatch review --mode deslopify --limit 3
clawpatch report
clawpatch next
clawpatch show --finding <id>
clawpatch triage --finding <id> --status false-positive --note "covered by tests"
clawpatch fix --finding <id>
clawpatch revalidate --finding <id>
clawpatch revalidate --all --status open
```

`fix` does not commit, push, open PRs, or land changes. It runs configured
validation commands and records a patch attempt under `.clawpatch/`.

## What It Maps Today

- npm package bins
- selected root and workspace package scripts: `start`, `build`, `test`,
  `lint`, `typecheck`, `format`
- Node/TypeScript workspace packages under `apps/*`, `packages/*`, and package
  workspace patterns
- generic extension/plugin packages under workspace roots such as `extensions/*`
  and `plugins/*`, including package metadata, source, docs, and nearby tests
- semantic Node source groups for large packages, including runtime, commands,
  auth, storage, monitor, webhook, setup, server, and client slices
- Nx project metadata from `project.json`, including project-scoped validation
  targets
- Turborepo task metadata for workspace-aware validation commands and feature
  context
- Next.js `app/` and `pages/` routes, including routes inside monorepo apps
- React Router routes and React components
- Go package slices from `go list ./...`, including command packages
- Go package tests and same-repo imports as review context
- Java/Kotlin Gradle source groups and root Gradle build/test commands
- JVM semantic roles from Java and Kotlin code evidence such as annotations,
  imports, interfaces, inheritance, supertypes, and method signatures
- Kotlin Android semantic roles for UI entrypoints, ViewModels, data
  boundaries, external clients, and dependency injection, including Metro
- C#/.NET projects from `.sln`, `.slnx`, `.csproj`, `.fsproj`, and `.vbproj`
  files, with conservative `dotnet build` / `dotnet test` defaults
- ASP.NET Core controllers, minimal API endpoints, C#/F#/Visual Basic source
  groups, and .NET test projects
- Ruby project metadata, executables, source groups, RSpec/Minitest suites
- Elixir Mix/Phoenix projects, contexts, Phoenix web slices, runtime config,
  Ecto migrations, project scripts, and ExUnit suites
- Rust `src/main.rs`, `src/bin/*.rs`, `src/lib.rs`, `crates/*`, and
  `tests/*.rs`
- C/C++ standalone `main()` files, CMake `add_executable` / `add_library`
  targets, and autotools `bin_PROGRAMS` / `lib_LTLIBRARIES` targets
- Python project metadata, console scripts, bounded source groups, pytest suites,
  and Flask/FastAPI routes
- SwiftPM `Sources/*` targets and `Tests/*` suites
- Laravel/PHP projects from `composer.json` and `artisan`, including routes,
  controllers, form requests, Artisan commands, jobs, services, models,
  migrations, seeders, Composer scripts, and PHP test suites
- common project config files

Deeper framework mappers and agent-assisted enrichment are next steps.

## Provider

The default provider is the local Codex CLI.

```bash
codex --version
clawpatch doctor
```

Provider calls use `codex exec` with strict JSON schemas. Review and revalidate
run read-only; fix planning runs with workspace-write because Codex may edit the
working tree during the explicit fix command.

Set `CLAWPATCH_CODEX_SANDBOX` to override the Codex sandbox passed by
Clawpatch. Use any Codex sandbox mode, or `bypass`/`none` to pass
`--dangerously-bypass-approvals-and-sandbox` when the host environment already
provides isolation.

Supported provider names today:

- `codex`: local Codex CLI
- `acpx`: any ACP-compatible coding agent (Codex / Claude / Pi / Gemini / ...) via openclaw/acpx
- `grok`: local Grok Build CLI
- `opencode`: local OpenCode CLI
- `mock`: deterministic test provider
- `mock-fail`: failure test provider

## Commands

- `clawpatch init`: create `.clawpatch/`, detect project basics, write config
- `clawpatch map`: write feature records
- `clawpatch status`: show project, dirty state, feature/finding counts
- `clawpatch review`: review pending or selected features
- `clawpatch review --mode deslopify`: review only for locally provable slop cleanup
- `clawpatch report`: print or write a Markdown findings report
- `clawpatch next`: print the next actionable finding
- `clawpatch show --finding <id>`: inspect one finding with evidence and suggested validation
- `clawpatch triage --finding <id> --status <status>`: mark a finding with optional history note
- `clawpatch fix --finding <id>`: run the explicit patch loop for one finding
- `clawpatch revalidate --finding <id>`: re-check one finding
- `clawpatch revalidate --all`: re-check open findings with report-style filters
- `clawpatch doctor`: check provider availability
- `clawpatch clean-locks`: clear feature locks

Useful flags:

- `--root <path>`
- `--state-dir <path>`
- `--config <path>`
- `--json`
- `--plain`
- `--limit <n>`
- `--jobs <n>`
- `--source <heuristic|auto|agent>`
- `--feature <id>`
- `--project <name-or-root>`
- `--finding <id>`
- `--status <status>`
- `--severity <severity>`
- `--provider <name>`
- `--model <name>`
- `--reasoning-effort <none|minimal|low|medium|high|xhigh>`
- `--skip-git-repo-check`
- `--output <path>` / `-o <path>`
- `--dry-run`
- `--force`

Unknown flags fail fast.

## State

State is project-local by default:

```text
.clawpatch/
  config.json
  project.json
  features/*.json
  findings/*.json
  patches/*.json
  reports/*.md
  runs/*.json
```

Feature records are the durable work units. Findings and patch attempts link back
to features so runs can resume and be audited.

## Safety

- Review does not edit files.
- Fix is explicit and selected by finding ID.
- Fix refuses a dirty source worktree by default.
- Clawpatch never commits, pushes, opens PRs, or lands changes today.
- Provider output is parsed through strict schemas.
- Symlinked directories and generated build output are skipped during mapping.

See `docs/spec.md` for the longer product and implementation spec.
