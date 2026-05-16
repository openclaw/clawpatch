---
title: Providers
description: "AI provider configuration and model selection"
---

# Providers

The default provider is the local Codex CLI.

```bash
clawpatch doctor
```

Provider names today:

- `codex`: shells out to `codex exec`
- `opencode`: shells out to `opencode run --format json`
- `mock`: deterministic provider for tests and fixtures
- `mock-fail`: failure provider for tests

Codex invocation:

- review: read-only sandbox
- revalidate: read-only sandbox
- fix: workspace-write sandbox
- output: strict JSON schema via `--output-schema`
- final message capture: `--output-last-message`

Opencode invocation:

- review: `opencode run --format json`
- revalidate: `opencode run --format json`
- fix: `opencode run --format json --dangerously-skip-permissions`
- output: parsed from NDJSON text events, extracted with `extractJson`

Model selection:

```bash
clawpatch review --model <model>
CLAWPATCH_MODEL=<model> clawpatch review
```

Provider selection:

```bash
clawpatch review --provider codex
CLAWPATCH_PROVIDER=codex clawpatch review
```

Opencode model selection requires the `provider/model` format:

```bash
clawpatch review --provider opencode --model opencode/big-pickle
CLAWPATCH_PROVIDER=opencode CLAWPATCH_MODEL=opencode/big-pickle clawpatch review
```

Direct OpenAI, Claude, Gemini, local-model, and multi-model panel providers are
not implemented yet.
