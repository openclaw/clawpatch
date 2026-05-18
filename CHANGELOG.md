# Changelog

## 0.2.1 - Unreleased

- Added deslopify review mode and ranked maintainability/performance report clusters for repeated cleanup patterns, thanks @mbelinky.
- Added a `pi` provider for routing review, fix, revalidate, and agent map through the [pi coding agent](https://pi.dev) in non-interactive print mode, thanks @danielmarbach.
- Added explicit Codex reasoning effort selection via `--reasoning-effort`, `CLAWPATCH_REASONING_EFFORT`, and provider config, with `doctor` reporting the active setting.
- Added `--skip-git-repo-check` for Codex-backed map, review, fix, and revalidate commands so initialized non-Git roots can run Codex, thanks @im-zayan.
- Added `CLAWPATCH_CODEX_SANDBOX` for overriding Codex provider sandbox mode when the host already provides isolation, thanks @IAMSamuelRodda.
- Added deterministic Express, Fastify, and Hono route mapping for Node projects, thanks @rohitjavvadi.
- Fixed provider commands with relative `--root` paths by canonicalizing explicit roots before invoking Codex or other providers.
- Added first-pass Elixir Mix/Phoenix mapping for project metadata, contexts, Phoenix web slices, runtime config, Ecto migrations, project scripts, ExUnit tests, and Mix validation defaults, thanks @tears-mysthrala.
- Improved `clawpatch fix` handoff context and patch-attempt changed-file auditing for dirty-worktree fixes.
- Improved Node workspace mapping with richer package overview features, generic extension package context, semantic large-source splits, and stricter generated/build ownership hygiene.
- Improved Kotlin JVM and Android semantic role mapping for Gradle projects, including Android plugin aliases, local type handling, comment/string parsing, and role fallback edges, thanks @mrmans0n.
- Added C#/.NET detection, conservative `dotnet build` / `dotnet test` defaults, ASP.NET Core route mapping, C#/F#/Visual Basic source groups, and .NET test-project mapping including TUnit, thanks @SimonGuldager with ideas from @danielmarbach.
- Fixed .NET mapping to avoid including `NuGet.config` in review context and to reject stale or commented solution project entries when choosing validation defaults.

## 0.2.0 - 2026-05-17

- Added the `acpx` provider for routing review, fix, and revalidate through ACP-compatible coding agents, thanks @mvanhorn.
- Added an OpenCode CLI provider for review, fix, revalidate, and doctor flows, thanks @Ashwinhegde19.
- Added a Grok CLI provider for review, fix, revalidate, and doctor flows, thanks @ebastos.
- Added `clawpatch map --source auto|agent` to invoke the configured provider as a read-only agent mapper when deterministic mapping is too shallow.
- Fixed agent mapping so provider-derived slices augment deterministic slices instead of retiring useful heuristic coverage on large repos.
- Fixed ACPX provider calls so stalled child agents time out instead of hanging indefinitely.
- Improved `clawpatch map` progress output and Rust mapping latency by reporting mapper activity on stderr and avoiding repeated Rust test discovery walks, thanks @optozorax.
- Added `--since <ref>` on `clawpatch review` and `clawpatch revalidate` to restrict runs to features whose owned or context files changed since the given git ref, thanks @mvanhorn.
- Improved Node/TypeScript mapping for large workspaces by splitting package source trees into bounded review groups with package-local tests.
- Added generic nested SwiftPM, Apple/Xcode, and Gradle/Android app mapping.
- Added React Router and React component mapping, thanks @moritzscheele.
- Added Next.js route mapping for `src/app` and `src/pages` layouts, thanks @obatried.
- Added Laravel/PHP feature mapping for routes, controllers, form requests, Artisan commands, jobs, services, models, migrations, seeders, Composer scripts, and PHP tests, thanks @Jonathanm10.
- Added Ruby and Rails feature mapping while excluding legacy Rails secrets from reviewable config, thanks @inertia186.
- Added FastAPI route feature mapping and kept root/web Python project detection in sync.
- Added Flask route feature mapping for Python projects, including `web/` source roots, common root entry files, non-list method literals, and Python framework detection.
- Added first-pass Python mapping for project metadata, console scripts, source groups, pytest suites, and conservative validation defaults, thanks @xiamx.
- Improved Python mapping for `setup.cfg`/`setup.py` project metadata and console scripts, plus `black --check .` format defaults.
- Added Kotlin semantic role mapping for Gradle projects, including Android UI, ViewModel, data, external client, dependency injection, and server-side role slices, thanks @mrmans0n.
- Added JVM semantic role mapping from Java annotations, imports, inheritance, interfaces, and method signatures.
- Detected Java/Kotlin language and default Gradle build/test commands for root Gradle projects.
- Added generic C/C++ feature mapping for standalone `main()` files, CMake `add_executable` / `add_library` targets, and autotools `bin_PROGRAMS` / `lib_LTLIBRARIES` targets, thanks @iliaal.
- Added Turborepo task metadata mapping for workspace-aware feature validation commands.
- Added selected package script mapping for Node workspace packages.
- Added progress output for `clawpatch revalidate`, thanks @twidtwid.
- Fixed overlapping `clawpatch review` runs so feature claims use atomic lock files and can be recovered with `clean-locks`, thanks @rohitjavvadi.
- Fixed `clawpatch fix` so feature-specific validation commands run during dry-run previews and applied fix validation, thanks @rohitjavvadi.
- Fixed Codex provider parsing for Markdown-wrapped JSON output with trailing prose, thanks @pranaysuyash.
- Fixed Codex provider execution on Windows paths with spaces and npm `.cmd` shims, thanks @1berto.
- Fixed Ruby/Rails project detection so `gems.rb` uses Bundler commands and Rails JavaScript roots avoid duplicate Node feature queues.
- Added security ownership, CodeQL, Dependabot, dependency review, and a private disclosure policy for repository automation and package integrity, plus fixed the first CodeQL mapper sanitizer finding.
- Updated development, GitHub Actions, and Node type dependencies, made dependency review skip cleanly when the GitHub API is unavailable, and fixed CodeQL ReDoS findings in Laravel route parsing.

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
