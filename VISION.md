# Clawpatch Vision

Clawpatch is an automated code-review and repair tool built on coding
harnesses. It maps repositories into bounded features, asks a coding agent to
review or repair them, validates the result, and preserves an auditable record.

Project overview: [`README.md`](README.md)
Provider details: [`docs/providers.md`](docs/providers.md)

## Core Boundary

Clawpatch integrates coding harnesses and agent CLIs, not model APIs.

A provider adapter belongs in Clawpatch when it launches an installed coding
harness that owns model transport, authentication, tool use, and coding-agent
behavior. Current examples include Codex, ACPX, Claude Code, Cursor Agent, Grok
Build, OpenCode, and Pi.

Clawpatch will not add direct model inference integrations. This excludes:

- HTTP clients or SDKs for chat, responses, or model inference APIs
- Clawpatch-owned provider API keys, base URLs, request envelopes, or billing behavior
- model-specific retry, quota, streaming, or structured-output transports
- read-only chat providers that cannot operate as coding harnesses

If a model provider needs support, add it to a coding harness or ACP adapter
first, then integrate that harness through its stable CLI or protocol. Model
selection and API authentication remain the harness's responsibility.
Adapters may pass documented authentication environment variables through to
the harness; they must not use those credentials to call model APIs themselves.

This boundary does not prohibit network access for non-model infrastructure
such as package registries. It specifically keeps model transport out of
Clawpatch.

## Principles

### 1. Harnesses own agent execution

Clawpatch should coordinate coding agents, not reimplement their model clients.
Harnesses own authentication, sessions, tools, permissions, model protocols,
and provider-specific compatibility.

### 2. Review and repair are one workflow

Provider integrations should fit the full coding lifecycle: inspect a checkout,
produce structured findings, plan or apply explicit fixes, and revalidate.
Partial support needs a strong reason and must still come from a coding
harness, not a bare inference endpoint.

### 3. Safety stays explicit

Review and revalidation should be read-only. Repair remains an explicit command
with clean-worktree checks, bounded permissions, validation, and an audit trail.
Clawpatch should expose the harness's security boundary honestly rather than
claiming stronger isolation than the harness provides.

### 4. Keep provider code small

An adapter should translate Clawpatch's stable inputs and schemas to a harness's
documented CLI or protocol. Provider-specific transport stacks and credential
systems are out of scope.

## Contribution Guardrail

Pull requests and issues proposing direct model API providers are out of scope
and will be closed. Proposals for new coding harnesses should document the
harness command or protocol, authentication ownership, read/write permission
model, structured-output path, timeout behavior, and real review/repair proof.
