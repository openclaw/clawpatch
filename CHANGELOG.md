# Changelog

## Unreleased

- Added generic C/C++ feature mapping for standalone `main()` files, CMake `add_executable` / `add_library` targets, and autotools `bin_PROGRAMS` / `lib_LTLIBRARIES` targets, thanks @iliaal.
- Added security ownership, CodeQL, Dependabot, dependency review, and a private disclosure policy for repository automation and package integrity, plus fixed the first CodeQL mapper sanitizer finding.
- Added Turborepo task metadata mapping for workspace-aware feature validation commands.
- Updated development, GitHub Actions, and Node type dependencies, made dependency review skip cleanly when the GitHub API is unavailable, and fixed CodeQL ReDoS findings in Laravel route parsing.
- Added JVM semantic role mapping from Java annotations, imports, inheritance, interfaces, and method signatures.
- Added Ruby and Rails feature mapping while excluding legacy Rails secrets from reviewable config, thanks @inertia186.
- Fixed Ruby/Rails project detection so `gems.rb` uses Bundler commands and Rails JavaScript roots avoid duplicate Node feature queues.
- Improved Python mapping for `setup.cfg`/`setup.py` project metadata and console scripts, plus `black --check .` format defaults.
- Added selected package script mapping for Node workspace packages.
- Detected Java/Kotlin language and default Gradle build/test commands for root Gradle projects.
- Added FastAPI route feature mapping and kept root/web Python project detection in sync.
- Added Laravel/PHP feature mapping for routes, controllers, form requests, Artisan commands, jobs, services, models, migrations, seeders, Composer scripts, and PHP tests, thanks @Jonathanm10.
- Added Kotlin semantic role mapping for Gradle projects, including Android UI, ViewModel, data, external client, dependency injection, and server-side role slices, thanks @mrmans0n.
- Added a Grok CLI provider for review, fix, revalidate, and doctor flows, thanks @ebastos.
- Added `--since <ref>` on `clawpatch review` and `clawpatch revalidate` to restrict runs to features whose owned or context files changed since the given git ref, thanks @mvanhorn.
- Added Flask route feature mapping for Python projects, including `web/` source roots, common root entry files, non-list method literals, and Python framework detection.
- Added the `acpx` provider for routing review, fix, and revalidate through ACP-compatible coding agents, thanks @mvanhorn.
- Added Next.js route mapping for `src/app` and `src/pages` layouts, thanks @obatried.
- Added first-pass Python mapping for project metadata, console scripts, source groups, pytest suites, and conservative validation defaults, thanks @xiamx.
- Added progress output for `clawpatch revalidate`, thanks @twidtwid.
- Fixed overlapping `clawpatch review` runs so feature claims use atomic lock files and can be recovered with `clean-locks`, thanks @rohitjavvadi.
- Added React Router and React component mapping, thanks @moritzscheele.
- Improved Node/TypeScript mapping for large workspaces by splitting package source trees into bounded review groups with package-local tests.
- Added generic nested SwiftPM, Apple/Xcode, and Gradle/Android app mapping.
- Fixed Codex provider execution on Windows paths with spaces and npm `.cmd` shims, thanks @1berto.
- Fixed `clawpatch fix` so feature-specific validation commands run during dry-run previews and applied fix validation, thanks @rohitjavvadi.

## 0.1.0 - 2026-05-15

- Added the initial strict TypeScript `clawpatch` CLI scaffold with `init`, `map`, `status`, `review`, `report`, `fix`, `revalidate`, `doctor`, and `clean-locks`.
- Added feature-centered state, Codex CLI provider integration, strict provider schemas, tests, docs, and a static website draft.
- Added SwiftPM and Rust/Cargo project detection, default commands, and deterministic feature mapping.
- Improved Go package mapping, review progress, parallel review jobs, report filtering, finding triage, and file/line evidence output.
- Added finding queue commands, triage history, bulk revalidation filters, and stricter review evidence/test-analysis fields.
- Fixed unsupported command-specific flags being accepted and ignored by commands that do not implement them.
- Fixed value-taking CLI flags so a following option token is reported as a missing value instead of consumed.
- Fixed packaging and lint wiring so npm packs rebuild `dist/` and `pnpm lint` loads `oxlint.json` without warning noise.
- Fixed package bin mapping so generated `dist`/`build` entries prefer matching TypeScript source files.
- Changed the npm package name to `clawpatch` for the public registry release.
