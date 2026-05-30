# Changelog

## 0.4.1 - Unreleased

- Fixed Codex provider calls to time out stalled `codex exec` children and release review locks, thanks @camwest.
- Fixed Claude provider auth isolation to pass explicit Vertex AI, Google ADC, and Bedrock/AWS auth environment variables, thanks @zanetworker.
- Fixed Python review prompts to include target runtime metadata and avoid flagging Python 3.14 syntax such as PEP 758 exception handlers as invalid, thanks @rohitjavvadi.
- Fixed mapper-generated validation commands to quote repository-derived paths, package names, script names, and test paths before shell execution, thanks @rohitjavvadi.

## 0.4.0 - 2026-05-22

- Added `clawpatch ci` to initialize, map, review, write a report, and append a GitHub Actions step summary in one CI-friendly command.
- Added `clawpatch open-pr --patch <id>` to turn an applied patch attempt into an explicit GitHub pull request.
- Added a `claude` provider for routing map, review, fix, and revalidate through the local Claude Code CLI in print mode, thanks @aurokin.
- Added an experimental `cursor` provider for local Cursor Agent CLI review workflows behind explicit opt-in gates, thanks @aurokin.
- Added review prompt provenance and budget accounting for included files, omitted files, prompt bytes, and approximate tokens.
- Added retries for transient acpx JSON review failures via `--prompt-retries` and `CLAWPATCH_REVIEW_RETRIES`, thanks @coletebou.
- Hardened review ingestion so provider findings must cite included files with valid line ranges and matching evidence quotes.
- Fixed provider review to preserve valid sibling findings when per-finding schema or evidence validation fails, recording drops in `run.errors` as non-fatal `schema-drop` or `validation-drop` entries, thanks @coletebou.
- Improved provider schema validation failures so `run.errors[].message` shows compact one-line Zod issue summaries, thanks @coletebou.
- Added `total` and `results` aliases on `clawpatch report --json` output while keeping the legacy `findings` count, thanks @coletebou.
- Fixed `clawpatch open-pr` so repositories without default-branch metadata use a dedicated patch branch and let GitHub choose the PR base.
- Fixed `clawpatch open-pr` retries to push the recorded patch commit instead of any later local branch tip.
- Fixed first-time `clawpatch open-pr` branch creation to start from the recorded patch base.
- Fixed command execution so providers that exit before reading stdin do not surface benign `EPIPE` errors.
- Fixed `clawpatch ci --since` empty-review output so it reports `reviewed: 0`.
- Fixed formatter configuration so `oxfmt` uses two-space indentation consistently across platforms.
- Added generic package-less monorepo app-root mapping for Node/Next projects under roots such as `apps/*` and `packages/*` when positive source or framework signals are present.
- Added Maven project mapping for root, nested, and multi-module Java/Kotlin projects with Spring role slices, Maven validation defaults, and `pom.xml` detection, thanks @julianshess.
- Added a release-prep checklist for auditing changelog, package metadata, and dry-run package contents without publishing.
- Improved bounded source grouping so large flat directories split repeated filename families like command, plugin, doctor, and runtime files into more coherent review slices.
- Fixed acpx provider error reporting by reading the terminal `result.stopReason` envelope and surfacing non-`end_turn` reasons as typed `ClawpatchError` codes (`agent-cancelled`, `agent-refused`, `agent-truncated`) instead of opaque `malformed-output`, thanks @coletebou.
- Added website crawler artifacts and a static smoke check for metadata, anchors, and social-card dimensions, thanks @zack-dev-cm.
- Improved OpenCode malformed JSON diagnostics with output length, event kinds, and a bounded preview, thanks @rohitjavvadi.
- Fixed finding signatures so equivalent evidence remains stable across re-reviews, thanks @rohitjavvadi.
- Fixed provider exit-code classification for stdout-only authentication and quota failures, thanks @rohitjavvadi.
- Improved Node route mapping to preserve literal Express and Hono mount prefixes, thanks @rohitjavvadi.
- Improved Flask route mapping to preserve static blueprint URL prefixes, thanks @rohitjavvadi.
- Improved Django route mapping to preserve literal `include()` route prefixes, thanks @rohitjavvadi.
- Added conservative Rails route mapping for literal root and HTTP verb routes, thanks @rohitjavvadi.
- Fixed heuristic feature mapping to honor configured path include/exclude filters, thanks @schedawg74.
- Fixed Express route mapping for aliased Router imports that follow block comment banners, thanks @rohitjavvadi.
- Fixed Laravel route mapping to include array-style `Route::group` prefixes, thanks @rohitjavvadi.
- Fixed Fastify route-object mapping to emit static method arrays while ignoring dynamic entries, thanks @rohitjavvadi.
- Fixed Fastify plugin callback route mapping for typed parameters and plugin aliases, thanks @rohitjavvadi.
- Fixed FastAPI route mapping to include static `APIRouter(prefix=...)` values, thanks @AsishKumarDalal.
- Added `--include-dirty` to review, CI, and revalidation file filters for auditing uncommitted worktree changes, thanks @AsishKumarDalal.
- Fixed Bun package-manager detection to recognize the text `bun.lock` lockfile, thanks @austinm911.
- Fixed review-output schema to tolerate optional `reproduction` and `minimumFixScope` fields and zero-valued evidence line numbers (normalized to `null`), recovering 4 of 28 zod issue patterns observed in run `20260517T190759-3c9e9e` (78 errors over 1000 features) that previously dropped whole-feature output instead of the affected finding.
- Changed `clawpatch review --jobs` and `clawpatch ci --jobs` defaults from a fixed `10` to `floor(cpuCores / 2)` clamped to `[1, 10]`, thanks @coletebou.
- Added `clawpatch review --rate-limit-per-minute <n>` (also `CLAWPATCH_RPM`) to cap how many provider calls may start within any rolling 60s window across jobs, thanks @coletebou.

## 0.3.0 - 2026-05-18

- Added a `pi` provider for routing review, fix, revalidate, and agent map through the [pi coding agent](https://pi.dev) in non-interactive print mode, thanks @danielmarbach.
- Added deslopify review mode and ranked maintainability/performance report clusters for repeated cleanup patterns, thanks @mbelinky.
- Fixed `clawpatch review --since` to review all touched features by default instead of silently applying the normal single-feature limit.
- Added `--skip-git-repo-check` for Codex-backed map, review, fix, and revalidate commands so initialized non-Git roots can run Codex, thanks @im-zayan.
- Added explicit Codex reasoning effort selection via `--reasoning-effort`, `CLAWPATCH_REASONING_EFFORT`, and provider config, with `doctor` reporting the active setting.
- Added `CLAWPATCH_CODEX_SANDBOX` for overriding Codex provider sandbox mode when the host already provides isolation, thanks @IAMSamuelRodda.
- Added `clawpatch review --prompt-file` to append extra reviewer guidance from a file or stdin, thanks @dpdanpittman.
- Added `clawpatch review --export-tribunal-ledger` to emit review findings as JSONL for downstream ledger ingestion, thanks @dpdanpittman.
- Added deterministic Express, Fastify, and Hono route mapping for Node projects, thanks @rohitjavvadi.
- Fixed Express route mapping to recognize aliased Router factories from imports, CommonJS destructuring, and direct assignments, thanks @rohitjavvadi.
- Added conservative Django `urls.py` route mapping for `path`, `re_path`, and legacy `url` declarations, thanks @rohitjavvadi.
- Added first-pass Elixir Mix/Phoenix mapping for project metadata, contexts, Phoenix web slices, runtime config, Ecto migrations, project scripts, ExUnit tests, and Mix validation defaults, thanks @tears-mysthrala.
- Improved Kotlin JVM and Android semantic role mapping for Gradle projects, including Android plugin aliases, local type handling, comment/string parsing, and role fallback edges, thanks @mrmans0n.
- Added C#/.NET detection, conservative `dotnet build` / `dotnet test` defaults, ASP.NET Core route mapping, C#/F#/Visual Basic source groups, and .NET test-project mapping including TUnit, thanks @SimonGuldager with ideas from @danielmarbach.
- Fixed .NET mapping to avoid including `NuGet.config` in review context and to reject stale or commented solution project entries when choosing validation defaults.
- Improved Node workspace mapping with richer package overview features, generic extension package context, semantic large-source splits, and stricter generated/build ownership hygiene.
- Fixed agent mapper inventory to honor Git ignored files, nested worktrees, and configured include/exclude filters, thanks @amiable-dev.
- Fixed provider commands with relative `--root` paths by canonicalizing explicit roots before invoking Codex or other providers.
- Improved Codex provider failures for missing Responses API write scope with direct credential and scope guidance.
- Improved `clawpatch fix` handoff context and patch-attempt changed-file auditing for dirty-worktree fixes.
- Fixed docs search matching, empty-state display, and mobile sidebar navigation, thanks @cloudsolutiongmbh.

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
