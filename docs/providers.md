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

- `codex`: shells out to `codex exec` (default)
- `acpx`: routes through any ACP-compatible coding agent via `acpx`
- `grok`: shells out to the xAI Grok Build CLI in headless mode (`grok --prompt-file`)
- `mock`: deterministic provider for tests and fixtures
- `mock-fail`: failure provider for tests

## Codex

Codex invocation:

- review: read-only sandbox
- revalidate: read-only sandbox
- fix: workspace-write sandbox
- output: strict JSON schema via `--output-schema`
- final message capture: `--output-last-message`

Model selection:

```bash
clawpatch review --model <model>
CLAWPATCH_MODEL=<model> clawpatch review
```

## ACPX

The `acpx` provider routes through `acpx <agent> exec`, where `<agent>` is any
ACP-compatible coding agent.

- review / revalidate: `--approve-reads` plus an explicit read-only prompt directive
- fix: `--approve-all`
- output: `--format json --json-strict --suppress-reads`, parsed from known ACP NDJSON envelope kinds
- tested envelope shape: `acpx@^0.8.0`

Permission caveat: `acpx --approve-all` is not the same as `codex --sandbox
workspace-write`. Codex's workspace-write mode is an enforced sandbox. ACPX
approval flags control ACP permission prompts; the underlying agent still has
whatever filesystem and network access its own runtime grants. For untrusted
code, run `clawpatch fix --provider acpx` inside an isolated checkout. For
review and revalidate, strict read-only behavior still depends on the underlying
agent honoring read-only permissions and the prompt directive.

Agent selection uses `--model` as `<agent>` or `<agent>:<model>`, split on the
first colon:

- unset: agent `codex`, default model
- `codex`: agent `codex`, default model
- `claude`: agent `claude`, default model
- `claude:sonnet-4-5`: agent `claude`, model `sonnet-4-5`
- `ollama:llama3:70b`: agent `ollama`, model `llama3:70b`

Migration note: `--provider codex --model gpt-5-codex` is not equivalent to
`--provider acpx --model gpt-5-codex`; the latter selects an ACP agent named
`gpt-5-codex`. Use `--provider acpx --model codex:gpt-5-codex`.

## Grok

The `grok` provider shells out to the local [Grok Build CLI](https://x.ai/cli).

Install the Grok CLI:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Then ensure `grok --version` works and authenticate using the flow supported by
the local Grok CLI.

Provider selection:

```bash
clawpatch review --provider grok
CLAWPATCH_PROVIDER=grok clawpatch review
clawpatch fix --finding <id> --provider grok --model grok-build
clawpatch doctor --provider grok
```

How the Grok provider works:

- Headless mode: `--prompt-file` plus `--output-format json --always-approve --verbatim --cwd <root>`
- Read-only operations: adds `--disallowed-tools "search_replace,run_terminal_cmd,Agent"`
- Write operations: uses full `--always-approve` so the agent can edit files and run validation commands
- Structured output: validates the returned JSON against the same Zod schemas used for Codex
- Large prompts: always uses `--prompt-file` instead of passing prompt text on the command line

Direct OpenAI API, local-model, and multi-model panel providers are not
implemented yet. The `acpx` provider is the generic route for ACP-compatible
agents; the `grok` provider is a direct integration for the local Grok CLI.
