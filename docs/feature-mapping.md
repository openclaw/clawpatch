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
- selected package scripts
- Node/TypeScript workspace packages from `package.json` workspaces, `pnpm-workspace.yaml`, and common package folders
- bounded Node/TypeScript source groups under `src/`, `lib/`, `app/`, `pages/`, and `scripts/`
- Next.js `app/` and `pages/` routes
- React Router `<Route path element>` declarations and React components in
  root or nested frontend packages such as `frontend/`, `client/`, `web/`,
  workspaces, and packages under `apps/` or `packages/`
- Go `cmd/*/main.go`
- Go `internal/*` packages
- Python project metadata, console scripts, bounded source groups, and pytest suites
- FastAPI `@app` and `@router` routes, including common `include_router`
  prefix wiring
- Rust Cargo commands, libraries, workspace crates, and integration tests
- SwiftPM executable targets, library targets, and test suites
- nested SwiftPM packages
- Apple/Xcode projects from `project.yml`, `.xcodeproj`, or `.xcworkspace`
- Gradle/Android modules from `settings.gradle(.kts)` and `build.gradle(.kts)`
- common config files

The mapper does not call a model. It uses repo conventions and cheap filesystem
walks, skips symlinked directories, and excludes common generated folders.

For large Node/TypeScript repositories, source groups are recursively split by
directory and then chunked so one feature owns at most a small bounded set of
files. Package-local tests and package context files are attached when they can
be found cheaply.

React mapping discovers packages with a React dependency, including common
nested frontend directories. It maps React Router route declarations to the
component they render when the component can be resolved from a local import or
lazy import, and also maps page/component files under `src/pages` and
`src/components` as UI-flow slices.

Native app mappers use the same bounded grouping model. SwiftPM packages can be
discovered below the repo root, Apple projects are grouped by Swift source area,
and Gradle modules are grouped from `src/main`, `src/test`, and `src/androidTest`.

Python mapping covers `pyproject.toml` metadata, `[project.scripts]` and
`[tool.poetry.scripts]` console scripts, source groups under common Python
source roots, pytest files, and FastAPI route decorators. FastAPI prefix
resolution handles common `app.include_router(...)` and nested
`api_router.include_router(..., prefix=...)` wiring.

Known gaps:

- no Express/Fastify/Hono route mapper yet
- no Flask/Django route mapper yet
- no import graph expansion beyond nearby tests yet
- no agent enrichment yet
