---
title: Installation
description: "How to install clawpatch from npm or source"
---

# Installation

## npm/pnpm

```bash
pnpm add -g clawpatch
```

Or with npm:

```bash
npm install -g clawpatch
```

Verify:

```bash
clawpatch --version
```

## From source

Clone and build:

```bash
git clone https://github.com/openclaw/clawpatch.git
cd clawpatch
pnpm install
pnpm build
pnpm link --global
```

Verify:

```bash
clawpatch --version
clawpatch doctor
```

## Provider setup

clawpatch requires an AI provider for code review. The default is the local Codex CLI.

### Codex CLI

Install the Codex CLI so `codex --version` works locally. If available in your
environment:

```bash
brew install codex
```

Verify:

```bash
codex --version
clawpatch doctor
```

`clawpatch doctor` checks the configured harness and reports its version. Most
providers do not make an authenticated model query during this check. Claude
host-auth mode also runs a minimal structured query; see [Providers](providers.md).

## Next steps

- [Quickstart](quickstart.md) - Run your first review
- [Configuration](configuration.md) - Customize behavior
- [Providers](providers.md) - Other provider options
