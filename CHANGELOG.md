# Changelog

## Unreleased

- Added Next.js route mapping for `src/app` and `src/pages` layouts, thanks @obatried.
- Added first-pass Python mapping for project metadata, console scripts, source groups, pytest suites, and conservative validation defaults, thanks @xiamx.
- Added progress output for `clawpatch revalidate`, thanks @twidtwid.
- Improved Node/TypeScript mapping for large workspaces by splitting package source trees into bounded review groups with package-local tests.
- Added generic nested SwiftPM, Apple/Xcode, and Gradle/Android app mapping.

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
