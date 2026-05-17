---
title: Code Review
description: "How clawpatch reviews features with AI providers and persists findings"
---

# Code Review

`clawpatch review` reviews feature records created by `clawpatch map`.

```bash
clawpatch review --limit 3
clawpatch review --limit 12 --jobs 4
clawpatch review --feature <featureId>
clawpatch review --since origin/main
clawpatch review --mode deslopify --limit 3
clawpatch review --provider codex --model <model>
```

Current behavior:

- selects pending features unless `--feature` is set
- claims each feature with an atomic lock file plus the feature run lock
- reviews with a bounded worker pool; default `--jobs` is `10`
- emits progress to stderr unless `--quiet` is set
- builds bounded prompt context from owned files, context files, and tests
- calls the configured provider
- requires strict JSON output
- writes findings under `.clawpatch/findings/`
- appends analysis history to the feature record
- releases the feature lock

## Flags

### --since <ref>

Restrict review to features whose owned or context files have changed in
`git diff --name-only --relative <ref>...HEAD`. Paths are compared relative to
the selected project root, so `--root` may point at a subdirectory inside a
larger Git repository. Useful for CI:

```bash
clawpatch review --since origin/main   # review what this branch changed
clawpatch review --since HEAD~5        # review the last 5 commits
```

If no features are touched by the diff, `review` exits cleanly with no findings.
The same flag is available on `revalidate`; revalidation scopes open findings to
features whose owned files changed.

Progress uses stderr so `--json` stdout remains machine-readable. The worker
pool is per-process, and lock files under `.clawpatch/locks/` prevent
overlapping review processes from claiming the same feature. Interrupted runs
can leave recoverable lock files; clear them with `clawpatch clean-locks` after
confirming no review process is still active. `clawpatch status` includes both
feature-record locks and lock files in `activeLocks`, and reports the lock-file
count as `lockFiles`.

There is no multi-provider panel yet.

### --mode deslopify

Use deslopify mode when you want one narrow lane for simplifying code and
improving performance by removing code slop. It restricts findings to
maintainability or performance issues caused by accidental complexity,
inefficient indirection, semantic duplication, needless wrappers, dead code, or
avoidable repeated work. It should not report unrelated correctness, security,
API contract, data-loss, or build-release issues; provider findings outside
maintainability and performance are discarded in this mode.

The deslopify rubric is intentionally narrow. It asks the provider to prioritize
locally provable slop patterns where the likely fix is deletion, consolidation,
or reuse of an existing local pattern:

- semantic duplication across files, tests, CLIs, SQL queries, adapters, wrappers,
  or generated-looking utilities
- shadow modules and thin pass-through wrappers
- concrete code bloat: generated-looking mass, production-included test/debug/demo
  artifacts, wrapper swarms, duplicated boilerplate, or manual registries that
  duplicate a source of truth
- dead legacy paths kept alive by tests
- cargo-cult defensive code that does not match a real trust boundary
- tautological or coupled tests that preserve implementation internals instead of
  behavior
- type/build silencing and band-aid hacks such as broad disables, `any`,
  `type-ignore`, sleeps/timeouts, path mutation, fake success returns, or removed
  checks, when simplification is the fix

It should not report file size, explicit generated files, normal framework
boilerplate, or domain modules that merely look large.

Categories requested from the provider:

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

Review does not edit files. Use `clawpatch fix --finding <id>` for the explicit
patch loop.
