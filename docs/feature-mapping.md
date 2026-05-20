---
title: Feature Mapping
description: "How clawpatch maps repositories into reviewable feature slices"
---

# Feature Mapping

`clawpatch map` creates durable feature records under `.clawpatch/features/`.

```bash
clawpatch map
clawpatch map --dry-run
clawpatch map --source auto
clawpatch map --source agent --provider codex
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
- package-less Node/TypeScript app roots under monorepo folders such as
  `apps/*` and `packages/*` when source files or positive framework signals are
  present
- Nx project metadata from `project.json`, including project names, source roots, project types, and target names
- Turborepo `turbo.json` metadata for workspace-aware validation commands and feature context
- bounded Node/TypeScript source groups under `src/`, `lib/`, `app/`,
  `pages/`, `scripts/`, `server/`, and `api/`, with oversized flat
  directories split by repeated filename families
- React Router `<Route path element>` declarations and React components in
  root or nested frontend packages such as `frontend/`, `client/`, `web/`,
  workspaces, and packages under `apps/` or `packages/`
- Express, Fastify, and Hono string-literal route declarations in root or
  workspace Node packages
- Next.js `app/` and `pages/` routes at the repo root or inside discovered monorepo projects
- Go `cmd/*/main.go`
- Go `internal/*` packages
- Python project metadata, console scripts, root app files, bounded source groups,
  pytest suites, and Flask/FastAPI/Django routes
- Java and Kotlin JVM semantic role groups, plus Kotlin Android semantic role
  groups including Hilt, Dagger, Koin, and Metro
- Ruby project metadata, executables, source groups, RSpec/Minitest suites,
  Rails configs, routes, views, assets, and database files
- Rust Cargo commands, libraries, workspace crates, and integration tests
- C/C++ standalone `main()` files, CMake targets, and autotools targets
- C#/.NET projects from `.sln`, `.slnx`, `.csproj`, `.fsproj`, and `.vbproj`,
  ASP.NET Core controllers, minimal API endpoints, C#/F#/Visual Basic source
  groups, and .NET test projects
- SwiftPM executable targets, library targets, and test suites
- nested SwiftPM packages
- Apple/Xcode projects from `project.yml`, `.xcodeproj`, or `.xcworkspace`
- Java/Kotlin Gradle modules from `settings.gradle(.kts)` and `build.gradle(.kts)`
- Java/Kotlin Maven modules from root and nested `pom.xml` files, including
  multi-module projects
- Laravel/PHP projects from `composer.json` and `artisan`, including controllers
  referenced by routes, form requests, Artisan commands, jobs, services, models,
  migrations, seeders, Composer scripts, and grouped PHP test suites
- common config files

The default mapper does not call a model. It uses repo conventions and cheap
filesystem walks, skips symlinked directories, and excludes common generated
folders. `map` emits progress to stderr unless `--quiet` is set, including
deterministic mapper start/done events, agent mapper decisions, write progress,
and elapsed time. JSON output stays on stdout.

When deterministic mapping is too shallow, `clawpatch map --source auto` can ask
the configured provider to split the repository into reviewable feature slices.
`--source auto` runs the deterministic mapper first and invokes the agent mapper
only when the result is weak, such as no features, only config features, very low
source coverage, or one/two features for a larger source tree. `--source agent`
forces the provider-backed mapper and adds its slices to the deterministic map
instead of retiring deterministic coverage. The agent mapper is read-only,
receives a bounded repository inventory rather than the whole repo, and Clawpatch
validates that every returned path exists inside the repository before writing
features. Agent-derived features use `source: agent-mapper` and include the
mapper reason in the feature summary.

For large Node/TypeScript repositories, package features include package
metadata such as `package.json`, TypeScript config, Vitest config, docs,
entrypoints, source overview files, and nearby tests. Source groups are split by
directory and then by common semantic subdomains such as runtime, commands,
auth, storage, monitor, webhook, setup, server, and client before falling back
to bounded chunks.
Generated/build outputs such as `node_modules`, `dist`, `build`, `.next`, and
generated source folders are not owned by Node review features.
Selected `package.json` scripts are mapped for the root package and discovered
workspace packages, with workspace script titles including the package name.
Workspace packages under generic extension/plugin roots such as `extensions/*`
and `plugins/*` are tagged as extension packages and keep package metadata,
source, docs, and tests together as review context.

In JavaScript/TypeScript monorepos, project discovery runs before framework
mapping. Workspace packages, Nx projects, and package-less app roots with source
or positive framework signals are normalized into project roots, so framework
mappers can apply the same heuristics to `apps/*` and `packages/*` that they
apply at the repository root. Hoisted Next route mapping uses positive evidence
such as local Next commands, local Next config, App Router files, or Pages API
files instead of trying to enumerate every non-Next config file. Feature tags
include project name and project root metadata, enabling commands such as:

```bash
clawpatch review --project apps/web --limit 10
clawpatch review --project web --limit 10
clawpatch report --project web --status open
clawpatch next --project web
```

When an Nx project target is available, nearby tests use the project-scoped
command, such as `yarn nx test web`, instead of a repository-wide test command.

When Turborepo metadata is available, mapped workspace features use filtered
Turbo validation commands such as `pnpm turbo run test --filter web`. Clawpatch
does not execute Turbo during mapping and leaves task dependency expansion to
Turbo when validation commands run.

React mapping discovers packages with a React dependency, including common
nested frontend directories. It maps React Router route declarations to the
component they render when the component can be resolved from a local import or
lazy import, and also maps page/component files under `src/pages` and
`src/components` as UI-flow slices.
Native app mappers use the same bounded grouping model. SwiftPM packages can be
discovered below the repo root, Apple projects are grouped by Swift source area,
Gradle modules are grouped from `src/main`, `src/test`, and `src/androidTest`,
and Maven modules are grouped from `src/main` and `src/test`. Root Gradle
projects get default `gradle`/`./gradlew` build and test commands; root Maven
projects get default `mvn`/`./mvnw` compile and test commands.
Java and Kotlin files in Gradle modules, plus Java files in Maven modules, also
get role-oriented review slices when code evidence identifies web entrypoints,
services, persistence boundaries, external clients, configuration, framework
components, extension boundaries, Android UI entrypoints, ViewModels, data
boundaries, or dependency injection.
Kotlin dependency-injection evidence includes Hilt, Dagger, Koin, and Metro
annotations and imports.

C#/.NET mapping reads solution/project files and C#/F#/Visual Basic source
without executing MSBuild. It emits project records, bounded source groups,
test-project records, ASP.NET Core controller routes, and minimal API routes. Default
validation commands are only generated when there is a single clear solution or
project target; ambiguous workspaces stay command-null rather than guessing.
Common generated outputs such as `bin/`, `obj/`, `TestResults/`, and `.g.cs`
files are skipped.

C/C++ mapping covers generic project shapes only: standalone source files with
`main()`, CMake `add_executable` / `add_library`, and autotools `bin_PROGRAMS` /
`lib_LTLIBRARIES`. It deliberately avoids project-specific C dialects such as
php-src extension metadata.

Python mapping covers `pyproject.toml`, `setup.cfg`, `setup.py`, and
`requirements.txt` metadata; `[project.scripts]`, `[tool.poetry.scripts]`,
`setup.cfg` `console_scripts`, and `setup.py` console script entry points; root
app files; source groups under common Python source roots including `web/`;
pytest files; Flask `@*.route(...)` handlers; FastAPI `@*.get(...)` /
`@*.api_route(...)` handlers; and conservative Django `urls.py` `path(...)`,
`re_path(...)`, and legacy `url(...)` declarations. Flask and FastAPI route
methods are read from list, tuple, or set literals. FastAPI paths can be
positional strings or literal `path=` keywords. Django route paths are normalized
from literal route strings and simple named regex groups; includes are mapped as
their own URL groups without recursively expanding imported URL configs. Default
Python command detection covers pytest, ruff, mypy, pyright, and black.

Ruby mapping covers project metadata, executables, source groups, RSpec and
Minitest suites, and Rails app structure. Rails legacy `config/secrets.yml`,
`config/database.yml`, and `config/initializers/secret_token.rb` are not mapped
as reviewable config because they can contain provider-sensitive secrets.

Known gaps:

- Express/Fastify/Hono route mapping is conservative and does not infer
  prefixes from cross-file router mounts such as `app.use("/api", router)`,
  `fastify.register(..., { prefix })`, or `app.route("/api", subApp)`
- Laravel route parsing is convention-based, does not execute Laravel route discovery,
  and may omit prefixes applied by `Route::group(...)` wrappers
- C#/.NET mapping does not evaluate MSBuild conditions, imported props/targets,
  or runtime route conventions
- no import graph expansion beyond nearby tests yet
- agent mapping depends on provider quality and validates paths but not semantic intent
