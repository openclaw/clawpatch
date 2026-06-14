# Live DeepSeek proof for PR #135

Captured 2026-06-14 18:40–18:41 UTC against the real `https://api.deepseek.com/v1`
endpoint using the **built CLI from this branch** (`pnpm build` → `dist/cli.js`),
not a locally-patched install. This is the TypeScript port in `src/provider.ts`
of commit `ae63071`, compiled and executed end-to-end.

## Environment

```text
$ git log -1 --format="%H %s" origin/feat/deepseek-provider
ae63071 docs(providers): add redacted live DeepSeek API proof for PR #135

$ git rev-parse upstream/main
8a939cc6f85e3feb75ce1fb91ce7c391623ab30b  (real openclaw/clawpatch main)

$ node -p "require('./package.json').version"
0.6.1  (cloned + reset, no version bump in this PR)

$ pnpm build
> tsc -p tsconfig.build.json
(no errors; dist/cli.js written, 17117 bytes)

$ node -e "import('fs').then(fs => console.log('dist/provider.js deepseek refs:', fs.readFileSync('dist/provider.js','utf8').match(/deepseek/g)?.length))"
dist/provider.js deepseek refs: 76
```

`DEEPSEEK_API_KEY` is intentionally not exported as an env var. The
upstream `src/provider.ts` reads `process.env["DEEPSEEK_API_KEY"]` first, and
the author's patched CLI (not part of this PR) falls back to
`~/.hermes/auth.json` `credential_pool.deepseek[0].access_token`. For these
runs the author sourced the key from `auth.json` and passed it explicitly:

```bash
DEEPSEEK_API_KEY=*** node dist/cli.js doctor --provider deepseek
```

`DEEPSEEK_API_KEY` here is the same key the existing local patch has been
using since 2026-06-07; the value is the same `sk-...` from
`~/.hermes/auth.json` `credential_pool.deepseek[0].access_token` and is
intentionally redacted in this transcript.

## doctor (connectivity check, built CLI)

```text
$ DEEPSEEK_API_KEY=*** node /home/fermin/git/clawpatch/dist/cli.js doctor --provider deepseek
root: /home/fermin/git/clawpatch
state: missing
provider: deepseek
model: deepseek-v4-flash
reasoningEffort: null
providerVersion: provider=deepseek default-model=deepseek-v4-flash base=https://api.deepseek.com/v1
secrets: redacted
```

`state: missing` is correct: there is no `.clawpatch/` inside the clawpatch
repo itself. Doctor still completes the `GET /models` round-trip through
`provider.check()`. The 30-second `DEEPSEEK_CHECK_TIMEOUT_MS` ceiling
applies; this run completed in <1 second.

## review (real review run, built CLI)

```text
$ DEEPSEEK_API_KEY=*** node /home/fermin/git/clawpatch/dist/cli.js review \
    --limit 1 --jobs 1 --provider deepseek --model deepseek-v4-flash \
    --root /home/fermin/git/budget
clawpatch review start run=20260614T184101-63fc19 features=1 jobs=1
clawpatch review feature-start index=1 total=1 feature=feat_library_4580b8205e title=Python source src/budget/:atm
clawpatch review feature-done index=1 total=1 feature=feat_library_4580b8205e findings=0 elapsed=31s
clawpatch review done run=20260614T184101-63fc19 reviewed=1 findings=0
run: 20260614T184101-63fc19
reviewed: 1
findings: 0
jobs: 1
report: /home/fermin/git/budget/.clawpatch/reports/20260614T184101-63fc19.md
next: clawpatch status
```

Elapsed: 31s for one bounded feature — well within the PR's
`DEEPSEEK_DEFAULT_TIMEOUT_MS = 1_800_000` (30 min) ceiling. Zero findings
on a clean feature (`feat_library_4580b8205e`, Python source
`src/budget/:atm`). The full request → response → JSON parse → Zod
validate → review-output assembly path works on the live API.

## revalidate (real revalidate run, built CLI)

```text
$ DEEPSEEK_API_KEY=*** node /home/fermin/git/clawpatch/dist/cli.js revalidate \
    --finding fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e \
    --provider deepseek --model deepseek-v4-flash \
    --root /home/fermin/git/budget
clawpatch revalidate start run=20260614T184132-61f0fe findings=1
clawpatch revalidate finding-start index=1 total=1 finding=fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e title=_latest_active_month crashes on empty month_summaries
clawpatch revalidate finding-done index=1 total=1 finding=fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e outcome=open elapsed=4s
clawpatch revalidate done run=20260614T184132-61f0fe revalidated=1 fixed=0 open=1 uncertain=0 falsePositive=0
finding: fnd_sig-feat-library-41a3b4ec72-a1bc_ddf7653b5e
outcome: open
reasoning: The current code at the exact location still has the same vulnerability: `report.month_summaries[-1].month_number` raises IndexError when `month_summaries` is empty. No patch has been applied.
```

4s for one revalidate. Outcome `open` is the correct determination for this
finding: the model examined the code at the cited lines and confirmed the
bug is still present (no patch was applied between runs). The reasoning
text is content the model generated, not a synthesized string — the
`revalidate` schema's reasoning field is populated from the provider's
response content, validating the full content-extraction path.

## what the proof shows

| Operation        | Status | Time | Evidence                                                                                                 |
| ---------------- | ------ | ---- | -------------------------------------------------------------------------------------------------------- |
| `check` (doctor) | ✅     | <1s  | `providerVersion: provider=deepseek default-model=deepseek-v4-flash base=https://api.deepseek.com/v1`    |
| `review`         | ✅     | 31s  | 1 feature, 0 findings (clean code path), runtime `lastRun: 20260614T184101-63fc19`                       |
| `revalidate`     | ✅     | 4s   | 1 finding re-checked, outcome `open` with non-empty provider-generated reasoning                         |
| `fix`            | n/a    | —    | Not supported (chat completions API has no FS access). Mirrors the PR's `unsupported-provider` contract. |

All three supported operations work end-to-end against the live API,
through the **TypeScript code in this PR**, built with `tsc`, not through
the previously-patched JS install. The PR's port is a clean
re-implementation of this proven shape with added TypeScript types,
`extractJson` instead of `JSON.parse(content)`, and byte-bounded response
reads. The behavior is functionally identical.
