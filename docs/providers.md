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
- `acpx`: routes review/fix/revalidate through any ACP-compatible coding agent (Codex / Claude / Pi / Gemini / OpenClaw ACP / ...) via openclaw/acpx
- `mock`: deterministic provider for tests and fixtures
- `mock-fail`: failure provider for tests

## codex provider

Invocation:

- review: read-only sandbox
- revalidate: read-only sandbox
- fix: workspace-write sandbox
- output: strict JSON schema via `--output-schema`
- final message capture: `--output-last-message`

## acpx provider

Routes through `acpx <agent> exec`, where `<agent>` is any ACP-compatible coding agent.

- review / revalidate: `--deny-all` (auto-deny all permission prompts; effectively read-only)
- fix: `--approve-all` (auto-approve all permission prompts)

**Permission model caveat.** `acpx --approve-all` is not the same as `codex --sandbox workspace-write`. Codex's workspace-write is an enforced sandbox: the runtime confines filesystem writes to the workspace and blocks network. acpx's `--approve-all` is a permission-prompt auto-approver. The underlying agent still has whatever filesystem and network access its own runtime grants. When running `clawpatch fix --provider acpx` on code you do not control, run inside a dedicated git worktree so the agent's blast radius is bounded by the filesystem you exposed.

### Agent selection

Pick the underlying ACP agent via `model`. Last-colon split, so the substring after the final `:` is the model ID:

| `model` value       | Agent           | Model         |
| ------------------- | --------------- | ------------- |
| (null / unset)      | `codex`         | agent default |
| `codex`             | `codex`         | agent default |
| `claude`            | `claude`        | agent default |
| `claude:sonnet-4-5` | `claude`        | `sonnet-4-5`  |
| `pi`                | `pi`            | agent default |
| `ollama:llama3:70b` | `ollama:llama3` | `70b`         |

### Migrating from `--provider codex`

`--provider codex --model gpt-5-codex` is not equivalent to `--provider acpx --model gpt-5-codex`. The latter selects an agent named `gpt-5-codex`. The correct migration is `--provider acpx --model codex:gpt-5-codex`.

### Tested versions

clawpatch was tested against `acpx@^0.8.0`. acpx is pre-1.0 and its NDJSON envelope shape may evolve. The provider's `check()` method reports the installed version against the tested range. If `extractAcpxJson` cannot find a known chunk kind, the malformed-output error names the envelope kinds it observed so version mismatches are diagnosable.

## Selection

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
