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
- reviews with a bounded worker pool; default `--jobs` is half of CPU cores, max 10
- caps provider call starts with `--rate-limit-per-minute <n>` or `CLAWPATCH_RPM`
- emits progress to stderr unless `--quiet` is set
- builds bounded prompt context from owned files, context files, and tests
- includes a prompt context manifest with included files, omitted files, byte
  counts, and truncation status
- calls the configured provider
- requires strict JSON output
- rejects findings whose evidence cites files outside the prompt context, stale
  line ranges, or quotes that do not match current file contents
- writes findings under `.clawpatch/findings/`
- appends analysis history to the feature record
- records prompt byte and approximate token counts in feature analysis history
- releases the feature lock

## Flags

### --feature-list <path>

Review exactly the feature ids listed in the file, in file order. The file must
contain one feature id per line. Blank lines are ignored and duplicate ids are
de-duplicated by first occurrence.

This mode is explicit feature selection, so it cannot be combined with
`--feature`, `--project`, `--since`, or `--include-dirty`.

```bash
clawpatch review --feature-list /tmp/features.txt
```

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

### CI command

Use `clawpatch ci` when a GitHub Actions job should run the whole read-only
review loop:

```bash
clawpatch ci --since origin/main --limit 20 --jobs 4 --output clawpatch-report.md
```

The command initializes `.clawpatch/` if needed, maps features, reviews the
selected feature set, writes a Markdown report when `--output` is provided, and
appends a compact summary to `GITHUB_STEP_SUMMARY` when that file is available.

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

## CUDA-aware review

When a feature owns CUDA `.cu` or `.cuh` sources, `clawpatch review` in default
mode and `clawpatch fix` add CUDA-specific guidance to the provider prompt:
kernel data races and synchronization barriers, unchecked CUDA runtime calls and
missing post-launch error checks, host versus device pointer confusion, unsafe
global- and shared-memory access, stream and event synchronization, and
device-memory leaks. Findings still use the existing categories; there is no
CUDA-specific category. Deslopify mode is unaffected.

Review does not edit files. Use `clawpatch fix --finding <id>` for the explicit
patch loop.
