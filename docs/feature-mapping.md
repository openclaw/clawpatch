---
title: Feature Mapping
description: "How clawpatch maps repositories into reviewable feature slices"
---

# Feature Mapping

`clawpatch map` creates durable feature records under `.clawpatch/features/`.

```bash
clawpatch map
clawpatch map --dry-run
```

A feature is a reviewable slice with:

- title and summary
- kind
- entrypoints
- owned files
- context files
- likely tests
- tags
- trust boundaries
- status and lock metadata

Supported deterministic mappers today:

- npm package bins
- selected root and workspace package scripts
- Node/TypeScript workspace packages from `package.json` workspaces, `pnpm-workspace.yaml`, and common package folders
- bounded Node/TypeScript source groups under `src/`, `lib/`, `app/`, `pages/`, and `scripts/`
- Next.js `app/` and `pages/` routes
- Go `cmd/*/main.go`
- Go `internal/*` packages
- Python project metadata, console scripts, root app files, bounded source groups,
  pytest suites, and Flask/FastAPI routes
- JVM semantic role groups from Java annotations, imports, inheritance, interfaces, and method signatures
- Rust Cargo commands, libraries, workspace crates, and integration tests
- SwiftPM executable targets, library targets, and test suites
- nested SwiftPM packages
- Apple/Xcode projects from `project.yml`, `.xcodeproj`, or `.xcworkspace`
- Java/Kotlin Gradle modules from `settings.gradle(.kts)` and `build.gradle(.kts)`
- common config files

The mapper does not call a model. It uses repo conventions and cheap filesystem
walks, skips symlinked directories, and excludes common generated folders.

For large Node/TypeScript repositories, source groups are recursively split by
directory and then chunked so one feature owns at most a small bounded set of
files. Package-local tests and package context files are attached when they can
be found cheaply.
Selected `package.json` scripts are mapped for the root package and discovered
workspace packages, with workspace script titles including the package name.

Native app mappers use the same bounded grouping model. SwiftPM packages can be
discovered below the repo root, Apple projects are grouped by Swift source area,
and Gradle modules are grouped from `src/main`, `src/test`, and `src/androidTest`.
Root Gradle projects get default `gradle`/`./gradlew` build and test commands.
Java files in Gradle modules also get role-oriented review slices when code
evidence identifies web entrypoints, services, persistence boundaries, external
clients, configuration, framework components, or extension boundaries.

Python mapping covers `pyproject.toml` metadata, `[project.scripts]` and
`[tool.poetry.scripts]` console scripts, root app files, source groups under
common Python source roots including `web/`, pytest files, Flask `@*.route(...)`
handlers, and FastAPI `@*.get(...)` / `@*.api_route(...)` handlers. Flask and
FastAPI route methods are read from list, tuple, or set literals. FastAPI paths
can be positional strings or literal `path=` keywords.

Known gaps:

- no Express/Fastify/Hono route mapper yet
- no Django route mapper yet
- no import graph expansion beyond nearby tests yet
- no agent enrichment yet
