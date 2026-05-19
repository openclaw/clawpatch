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
- `gemini`: shells out to Google Gemini CLI in headless mode
- `grok`: shells out to the xAI Grok Build CLI in headless mode (`grok --prompt-file`)
- `opencode`: shells out to `opencode run --format json`
- `pi`: shells out to `pi -p` (non-interactive print mode)
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

Reasoning effort selection:

```bash
clawpatch review --model gpt-5.5 --reasoning-effort xhigh
CLAWPATCH_REASONING_EFFORT=xhigh clawpatch review
```

When `reasoningEffort` is unset, Clawpatch does not pass a reasoning override
and Codex uses its own configured default. Explicit values are passed to Codex
as `model_reasoning_effort`.

## OpenCode

The `opencode` provider shells out to the local [OpenCode CLI](https://opencode.ai/docs/cli/).

- review / revalidate: `opencode run --format json --dir <root> --file <prompt>`
- fix: adds `--dangerously-skip-permissions`
- output: parsed from JSONL `text` events
- read-only operations: set `OPENCODE_PERMISSION` to deny edit, shell, subagent, and web tools
- model selection: `--model <provider/model>`

Provider selection:

```bash
clawpatch review --provider opencode --model opencode/big-pickle
CLAWPATCH_PROVIDER=opencode CLAWPATCH_MODEL=opencode/big-pickle clawpatch review
clawpatch fix --finding <id> --provider opencode
```

Permission caveat: OpenCode permissions are configuration-driven. Clawpatch
sets a restrictive `OPENCODE_PERMISSION` for review and revalidate, and uses
`--dangerously-skip-permissions` only during explicit `fix`. Review remains
prompted as read-only, but the same isolated-checkout guidance applies when
running third-party agents.

## ACPX

The `acpx` provider routes through `acpx <agent> exec`, where `<agent>` is any
ACP-compatible coding agent.

- review / revalidate: `--approve-reads` plus an explicit read-only prompt directive
- fix: `--approve-all`
- output: `--format json --json-strict --suppress-reads`, parsed from known ACP NDJSON envelope kinds
- tested envelope shape: `acpx@^0.8.0`
- timeout: 180 seconds by default, override with `CLAWPATCH_ACPX_TIMEOUT_MS` or `CLAWPATCH_PROVIDER_TIMEOUT_MS`

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

## Gemini

The `gemini` provider shells out to the local
[Gemini CLI](https://github.com/google-gemini/gemini-cli) in headless mode.

Install Gemini CLI and authenticate using one of the upstream-supported flows:

```bash
npm install -g @google/gemini-cli
gemini --version
```

Provider selection:

```bash
CLAWPATCH_GEMINI_TRUST_WORKSPACE=true clawpatch review --provider gemini
CLAWPATCH_GEMINI_TRUST_WORKSPACE=true clawpatch fix --finding <id> --provider gemini
CLAWPATCH_GEMINI_TRUST_WORKSPACE=true clawpatch doctor --provider gemini
```

How the Gemini provider works:

- Headless mode: `gemini --skip-trust -p "" --approval-mode=<mode> --output-format=json`
- Prompt delivery: Clawpatch writes the full prompt to stdin; it does not pass large prompts on argv
- Read-only operations (map, review, revalidate): use `--approval-mode=plan`
- Write operations (fix): use `--approval-mode=auto_edit`, not yolo mode
- Output: parses Gemini's JSON envelope and extracts the string `response` field before validating Clawpatch JSON
- Model selection: `--model <model>` is passed through when configured
- Reasoning effort and `skipGitRepoCheck`: not supported by Gemini CLI and are treated as no-ops
- Timeout: 180 seconds by default, override with `CLAWPATCH_GEMINI_TIMEOUT_MS` or `CLAWPATCH_PROVIDER_TIMEOUT_MS`

Security gates:

- Gemini CLI must be patched for GHSA-wpqr-6v78-jr5g. Clawpatch accepts
  stable versions `>=0.39.1` and preview versions `>=0.40.0-preview.3`.
  Set `CLAWPATCH_GEMINI_ALLOW_UNPATCHED=1` only for local diagnostics.
- Clawpatch uses `--skip-trust` because Gemini headless execution requires an
  explicit trusted-workspace path. You must opt in with
  `CLAWPATCH_GEMINI_TRUST_WORKSPACE=true`; use this only in an isolated checkout
  with no untrusted project Gemini configuration or secrets.
- Gemini subprocesses run with isolated temp `HOME` and XDG dirs. Clawpatch
  copies only the minimal verified Gemini auth/config files into that temp home,
  and forwards a small env allowlist: path/temp basics, explicit Google/Gemini
  auth variables, proxy and certificate vars, and `NO_COLOR`. Wildcard secret
  prefixes are not forwarded.
- Clawpatch passes `--extensions none` and prompts read-only operations not to use
  network, MCP, skills, subagents, shell, or write tools. Enforcement still
  depends on Gemini CLI policy behavior, so review untrusted code in an isolated
  checkout.

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

## Pi

The `pi` provider shells out to the local [pi coding agent](https://pi.dev)
in non-interactive print mode (`pi -p`).

Install pi:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or use a subscription:

```bash
pi
/login
```

Then verify:

```bash
pi --version
```

Provider selection:

```bash
clawpatch review --provider pi
CLAWPATCH_PROVIDER=pi clawpatch review
clawpatch fix --finding <id> --provider pi --model anthropic/claude-sonnet-4
clawpatch doctor --provider pi
```

How the pi provider works:

- Non-interactive mode: `pi -p --no-session` with all discovery flags disabled
  (`--no-context-files --no-skills --no-extensions --no-prompt-templates --no-themes`)
  to isolate the agent from project and user configuration
- Prompt delivery: written to a temp file and passed via `@<path>` file reference
- Read-only operations (map, review, revalidate): `--tools read` restricts the
  agent to the read tool only
- Write operations (fix): uses the default tool set (read, bash, edit, write)
- Model selection: `--model <pattern>` supports provider-prefixed IDs like
  `anthropic/claude-sonnet-4` and thinking-level shorthands like `sonnet:high`
- Reasoning effort: `--thinking <level>` maps from clawpatch's reasoning effort
- Output: parsed from stdout text using the shared `extractJson` helper
- Timeout: 180 seconds by default, override with `CLAWPATCH_PI_TIMEOUT_MS` or
  `CLAWPATCH_PROVIDER_TIMEOUT_MS`

Permission caveat: pi's `--tools read` restricts the agent to the read tool for
review and revalidate, but enforcement depends on pi honoring the tool allowlist.
For write operations during `fix`, the agent has full filesystem and shell access.
For untrusted code, run `clawpatch fix --provider pi` inside an isolated checkout.

Direct OpenAI API, local-model, and multi-model panel providers are not
implemented yet. The `acpx` provider is the generic route for ACP-compatible
agents; the `grok`, `opencode`, and `pi` providers are direct integrations
for local CLIs.
