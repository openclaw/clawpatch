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
- `grok`: shells out to the xAI Grok Build CLI in headless mode (`grok --prompt-file`)
- `mock`: deterministic provider for tests and fixtures
- `mock-fail`: failure provider for tests

### Codex

Codex invocation:

- review: read-only sandbox
- revalidate: read-only sandbox
- fix: workspace-write sandbox
- output: strict JSON schema via `--output-schema`
- final message capture: `--output-last-message`

### Grok

The `grok` provider shells out to the local [Grok Build CLI](https://x.ai/cli)

Install the Grok CLI:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Then ensure `grok --version` works and authenticate using the flow supported by the local Grok CLI.

**Provider selection:**

```bash
clawpatch review --provider grok
CLAWPATCH_PROVIDER=grok clawpatch review
clawpatch fix --finding <id> --provider grok --model grok-build
clawpatch doctor --provider grok
```

**Model selection** (works for both `codex` and `grok`):

```bash
clawpatch review --model <model>
CLAWPATCH_MODEL=<model> clawpatch review
```

#### How the grok provider works

- **Headless mode**: Uses `--prompt-file` + `--output-format json --always-approve --verbatim --cwd <root>`.
- **Read-only operations** (`review`, `revalidate`): Adds `--disallowed-tools "search_replace,run_terminal_cmd,Agent"` so the agent cannot modify files or run shell commands.
- **Write operations** (`fix`): Uses full `--always-approve` so the agent can edit files and run validation commands.
- **Structured output**: The inner prompt includes clawpatch's JSON schema. The provider parses the text field of the JSON envelope returned by `--output-format json` and validates it with Zod (same schemas used for Codex).
- **Large prompts**: Review and fix prompts can be tens of kilobytes (they embed the full source of owned and context files). Passing such prompts via `-p`/`--single` is unreliable, so the provider always uses `--prompt-file` (the intended mechanism for automation and large inputs).

Direct OpenAI, Claude, Gemini, local-model, and multi-model panel providers are
not implemented yet. The `grok` provider uses the local `grok` binary for the
best integration with the surrounding Grok Build environment.
