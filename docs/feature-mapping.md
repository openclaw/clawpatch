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
- Nx project metadata from `project.json`, including project names, source roots, project types, and target names
- bounded Node/TypeScript source groups under `src/`, `lib/`, `app/`, `pages/`, and `scripts/`
- React Router `<Route path element>` declarations and React components in
  root or nested frontend packages such as `frontend/`, `client/`, `web/`,
  workspaces, and packages under `apps/` or `packages/`
- Next.js `app/` and `pages/` routes at the repo root or inside discovered monorepo projects
- Go `cmd/*/main.go`
- Go `internal/*` packages
- Python project metadata, console scripts, root app files, bounded source groups,
  pytest suites, and Flask/FastAPI routes
- Java and Kotlin JVM semantic role groups, plus Kotlin Android semantic role
  groups including Hilt, Dagger, Koin, and Metro
- Ruby project metadata, executables, source groups, RSpec/Minitest suites,
  Rails configs, routes, views, assets, and database files
- Rust Cargo commands, libraries, workspace crates, and integration tests
- SwiftPM executable targets, library targets, and test suites
- nested SwiftPM packages
- Apple/Xcode projects from `project.yml`, `.xcodeproj`, or `.xcworkspace`
- Java/Kotlin Gradle modules from `settings.gradle(.kts)` and `build.gradle(.kts)`
- Laravel/PHP projects from `composer.json` and `artisan`, including controllers
  referenced by routes, form requests, Artisan commands, jobs, services, models,
  migrations, seeders, Composer scripts, and grouped PHP test suites
- common config files

The mapper does not call a model. It uses repo conventions and cheap filesystem
walks, skips symlinked directories, and excludes common generated folders.

For large Node/TypeScript repositories, source groups are recursively split by
directory and then chunked so one feature owns at most a small bounded set of
files. Package-local tests and package context files are attached when they can
be found cheaply.
Selected `package.json` scripts are mapped for the root package and discovered
workspace packages, with workspace script titles including the package name.

In JavaScript/TypeScript monorepos, project discovery runs before framework
mapping. Workspace packages and Nx projects are normalized into project roots,
so framework mappers can apply the same heuristics to `apps/*` and `packages/*`
that they apply at the repository root. Feature tags include project name and
project root metadata, enabling commands such as:

```bash
clawpatch review --project apps/web --limit 10
clawpatch review --project web --limit 10
clawpatch report --project web --status open
clawpatch next --project web
```

When an Nx project target is available, nearby tests use the project-scoped
command, such as `yarn nx test web`, instead of a repository-wide test command.

React mapping discovers packages with a React dependency, including common
nested frontend directories. It maps React Router route declarations to the
component they render when the component can be resolved from a local import or
lazy import, and also maps page/component files under `src/pages` and
`src/components` as UI-flow slices.

Native app mappers use the same bounded grouping model. SwiftPM packages can be
discovered below the repo root, Apple projects are grouped by Swift source area,
and Gradle modules are grouped from `src/main`, `src/test`, and `src/androidTest`.
Root Gradle projects get default `gradle`/`./gradlew` build and test commands.
Java and Kotlin files in Gradle modules also get role-oriented review slices
when code evidence identifies web entrypoints, services, persistence boundaries,
external clients, configuration, framework components, extension boundaries,
Android UI entrypoints, ViewModels, data boundaries, or dependency injection.
Kotlin dependency-injection evidence includes Hilt, Dagger, Koin, and Metro
annotations and imports.

Python mapping covers `pyproject.toml`, `setup.cfg`, `setup.py`, and
`requirements.txt` metadata; `[project.scripts]`, `[tool.poetry.scripts]`,
`setup.cfg` `console_scripts`, and `setup.py` console script entry points; root
app files; source groups under common Python source roots including `web/`;
pytest files; Flask `@*.route(...)` handlers; and FastAPI `@*.get(...)` /
`@*.api_route(...)` handlers. Flask and FastAPI route methods are read from list,
tuple, or set literals. FastAPI paths can be positional strings or literal
`path=` keywords. Default Python command detection covers pytest, ruff, mypy,
pyright, and black.

Ruby mapping covers project metadata, executables, source groups, RSpec and
Minitest suites, and Rails app structure. Rails legacy `config/secrets.yml`,
`config/database.yml`, and `config/initializers/secret_token.rb` are not mapped
as reviewable config because they can contain provider-sensitive secrets.

Known gaps:

- no Express/Fastify/Hono route mapper yet
- no Django route mapper yet
- Laravel route parsing is convention-based, does not execute Laravel route discovery,
  and may omit prefixes applied by `Route::group(...)` wrappers
- no import graph expansion beyond nearby tests yet
- no Turborepo task metadata mapper yet
- no agent enrichment yet
