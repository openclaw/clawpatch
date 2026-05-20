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
- `opencode`: shells out to `opencode run --format json`
- `pi`: shells out to `pi -p` (non-interactive print mode)
- `cursor`: shells out to `cursor-agent -p --output-format json`
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

## Cursor

The `cursor` provider shells out to the local Cursor Agent CLI in headless print
mode. It is experimental and disabled for `map`, `review`, `fix`, and
`revalidate` by default while HITL verification is incomplete.

Verify local availability:

```bash
cursor-agent --version
clawpatch doctor --provider cursor
```

Experimental provider selection:

```bash
CURSOR_API_KEY=... CLAWPATCH_CURSOR_EXPERIMENTAL=1 clawpatch review --provider cursor
CURSOR_API_KEY=... CLAWPATCH_CURSOR_EXPERIMENTAL=1 CLAWPATCH_PROVIDER=cursor clawpatch review
CURSOR_API_KEY=... CLAWPATCH_CURSOR_EXPERIMENTAL=1 CLAWPATCH_CURSOR_ALLOW_WRITE=1 clawpatch fix --finding <id> --provider cursor --model <model>
clawpatch doctor --provider cursor
```

How the Cursor provider works:

- Headless mode: `cursor-agent --trust -p --output-format json --workspace <root>`
- Read-only operations: also pass Cursor's documented `--mode ask`
- Output: parses Cursor's `type: "result"` JSON envelope and then extracts the
  Clawpatch JSON object from the `result` text
- Prompt delivery: writes the full Clawpatch prompt to Cursor's stdin
- Model selection: passes `--model <model>` when configured
- Model names: pass Cursor model ids, for example `composer-2.5` for Composer
  2.5 without fast mode
- Reasoning effort and `skipGitRepoCheck`: not mapped to Cursor CLI flags
- Authentication: experimental execution uses the host user environment and
  passes `CURSOR_API_KEY` through when present. Prefer API-key auth for headless
  runs; relying on the user's Cursor login can touch the macOS login keychain.
  Clawpatch also sets `NO_OPEN_BROWSER=1` to reduce browser prompts during
  headless runs.
- Read-only guard: map, review, and revalidate pass `--mode ask` and include
  read-only instructions in the prompt. Clawpatch does not set
  `CURSOR_CONFIG_DIR`, because that can bypass the user's existing Cursor auth
  profile and trigger browser login prompts.
- Timeout: 300 seconds by default, override with
  `CLAWPATCH_CURSOR_TIMEOUT_MS` or `CLAWPATCH_PROVIDER_TIMEOUT_MS`
- Advisory handling: semver-like Cursor CLI versions below `2.5.0` are blocked
  for CVE-2026-26268 / GHSA-8pcm-8jpx-hv8r. Date-formatted CLI builds are
  allowed only when Clawpatch can verify a semver Cursor app version from the
  local macOS app bundle.

Permission caveat: Cursor's print mode is documented as having access to tools,
including write and shell. Clawpatch therefore keeps Cursor execution behind
`CLAWPATCH_CURSOR_EXPERIMENTAL=1`, uses `--mode ask` for read-only operations,
and separately requires `CLAWPATCH_CURSOR_ALLOW_WRITE=1` for `fix`. The
implementation uses `--trust` for the explicit trusted-workspace path and never
uses `--force` or `--yolo`. Complete HITL verification before promoting this to
default provider support, especially for ambient rules, MCP configuration,
positional prompt exposure, timeout behavior, and any claimed read-only mode.

Direct OpenAI API, local-model, and multi-model panel providers are not
implemented yet. The `acpx` provider is the generic route for ACP-compatible
agents; the `grok`, `opencode`, `pi`, and `cursor` providers are direct integrations
for local CLIs.
