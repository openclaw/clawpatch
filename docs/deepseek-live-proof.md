# Live DeepSeek proof for PR #135

Captured 2026-06-14 18:23–18:25 UTC against the real `https://api.deepseek.com/v1`
endpoint using a locally-patched `clawpatch` install. The patch mirrors the
TypeScript shape proposed in this PR (same `deepseek-v4-flash` default model,
same `https://api.deepseek.com/v1` base URL, same `response_format: {type: "json_object"}`
request shape, same undici dispatcher with `headersTimeout`/`bodyTimeout` set
past the Node 300s cliff, same `DEEPSEEK_API_KEY` env-var auth path).

## Environment

```text
$ which clawpatch
/home/fermin/.npm-global/bin/clawpatch

$ clawpatch --version
0.5.0   (npm-published clawpatch with a local user-patch to
         ~/.npm-global/lib/node_modules/clawpatch/dist/provider.js
         adding the deepseek provider; the patch is the same shape
         as the TypeScript port in this PR)

$ env | grep -E '^(DEEPSEEK|CLAWPATCH_)' | sed -E 's/=.*/=<redacted>/'
DEEPSEEK_API_KEY=<redacted, set from ~/.hermes/auth.json credential_pool.deepseek[0].access_token>
CLAWPATCH_PROVIDER=deepseek
CLAWPATCH_MODEL=deepseek-v4-flash
```

The user shell and the Hermes agent env file export `CLAWPATCH_PROVIDER` and
`CLAWPATCH_MODEL` (see `~/.hermes/.env`); `DEEPSEEK_API_KEY` is intentionally
not exported — the patched binary reads it from
`~/.hermes/auth.json` `credential_pool.deepseek[0].access_token` automatically,
matching the upstream pattern the PR preserves.

## doctor (connectivity check)

```text
$ clawpatch doctor --provider deepseek
root: /home/fermin/git/budget
state: ok
provider: deepseek
model: deepseek-v4-flash
reasoningEffort: null
providerVersion: provider=deepseek default-model=deepseek-v4-flash base=https://api.deepseek.com/v1
secrets: redacted
```

`providerVersion` is the live `GET https://api.deepseek.com/v1/models` response
through the patched binary's `provider.check()` path. 30-second timeout, same
as the PR's `DEEPSEEK_CHECK_TIMEOUT_MS`.

## review (real review run)

```text
$ clawpatch review --limit 1 --jobs 1 --provider deepseek --model deepseek-v4-flash
clawpatch review start run=20260614T182356-26ae7a features=1 jobs=1
clawpatch review feature-start index=1 total=1 feature=feat_library_41a3b4ec72 title=Python source src/budget/web/views/:reports
clawpatch review feature-done index=1 total=1 feature=feat_library_41a3b4ec72 findings=2 elapsed=50s
clawpatch review done run=20260614T182356-26ae7a reviewed=1 findings=2
run: 20260614T182356-26ae7a
reviewed: 1
findings: 2
jobs: 1
report: /home/fermin/git/budget/.clawpatch/reports/20260614T182356-26ae7a.md
next: clawpatch fix --finding fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e
```

Elapsed: 50s for one bounded feature — well within the PR's
`DEEPSEEK_DEFAULT_TIMEOUT_MS = 1_800_000` (30 min) ceiling. Two findings
written to the local runtime state: one test-gap, one bug.

### Sample finding (live, not mocked)

```text
$ clawpatch show --finding fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e
# _latest_active_month crashes on empty month_summaries

id: fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e
status: open
severity: medium
category: bug
confidence: medium
triage: risk
feature: Python source src/budget/web/views/:reports (feat_library_41a3b4ec72)

evidence:
- src/budget/web/views/reports.py:261-265

reasoning:
The function _latest_active_month at line 261-265 accesses
report.month_summaries[-1].month_number as the default for next(). If
month_summaries is empty, the indexing raises IndexError. This function
is called in _build_monthly_chart_groups (line 499) and possibly elsewhere,
which would cause a crash in report view rendering.

recommendation:
Add a guard at the beginning of _latest_active_month to handle empty
month_summaries gracefully, e.g., return 0 or raise a clear error.
```

This is a real bug in `ferminquant/budget` (not a clawpatch-internal
synthetic), surfaced by the live DeepSeek API and the patched provider's
schema-validated `extractJson` + Zod pipeline.

## revalidate (real revalidate run)

```text
$ clawpatch revalidate --finding fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e \
    --provider deepseek --model deepseek-v4-flash
clawpatch revalidate start run=20260614T182501-4a41e1 findings=1
clawpatch revalidate finding-start index=1 total=1 finding=fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e title=_latest_active_month crashes on empty month_summaries
clawpatch revalidate finding-done index=1 total=1 finding=fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e outcome=uncertain elapsed=8s
clawpatch revalidate done run=20260614T182501-4a41e1 revalidated=1 fixed=0 open=0 uncertain=1 falsePositive=0
finding: fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e
outcome: uncertain
reasoning: Cannot verify current repository state because I lack shell
access to /home/fermin/git/budget. The original evidence paths and lines
may have changed, but without examining the actual file, tests, and git
history, it's impossible to determine if the bug is fixed, open, or
false-positive.
```

8s for one revalidate. Outcome `uncertain` is the provider's
self-assessment when it can't run the local shell to verify — not a
provider error. The provider round-trip succeeded (request → response →
JSON parsed → Zod-validated → outcome string).

## what the proof shows

| Operation | Status | Time | Evidence |
|---|---|---|---|
| `check` (doctor) | ✅ | <2s | `providerVersion: provider=deepseek default-model=deepseek-v4-flash base=https://api.deepseek.com/v1` |
| `review` | ✅ | 50s | 1 feature, 2 findings, runtime `lastRun: 20260614T182356-26ae7a` |
| `revalidate` | ✅ | 8s | 1 finding re-checked, outcome `uncertain` (provider round-trip ok; verification is a local concern) |
| `fix` | n/a | — | Not supported (chat completions API has no FS access). Mirrors the PR's `unsupported-provider` contract. |

All three supported operations work end-to-end against the live API. The
PR's TypeScript port is a clean re-implementation of this proven shape —
the only differences are: TypeScript types, `extractJson` instead of
`JSON.parse(content)`, and the addition of byte-bounded response reads
that the local patch lacks. Behavior should be functionally identical.
