---
title: Configuration
description: "Configure clawpatch behavior, providers, and validation commands"
---

# Configuration

Config is loaded from:

- `--config <path>`
- `$CLAWPATCH_CONFIG`
- `$CLAWPATCH_STATE_DIR/config.json`
- `clawpatch.config.json`
- `.clawpatch/config.json`
- built-in defaults

Default shape:

```json
{
  "schemaVersion": 1,
  "stateDir": ".clawpatch",
  "include": ["**/*"],
  "exclude": [
    "node_modules/**",
    "dist/**",
    "build/**",
    "target/**",
    ".build/**",
    ".git/**",
    ".clawpatch/**"
  ],
  "provider": {
    "name": "codex",
    "model": null,
    "reasoningEffort": null,
    "codexConfig": {}
  },
  "commands": {
    "typecheck": null,
    "lint": null,
    "format": null,
    "test": null
  },
  "review": {
    "maxContextFiles": 24,
    "maxOwnedFiles": 12,
    "maxFindingsPerFeature": 10,
    "minConfidenceToFix": "medium"
  },
  "git": {
    "requireCleanWorktreeForFix": true,
    "commit": false,
    "openPr": false
  },
  "registryVerifier": {
    "enabled": false
  }
}
```

`registryVerifier.enabled` controls the npm-registry post-validator that
drops direct `pkg@semver` public-npm publication claims refuted by
the public npm registry. It is disabled by default because lookups disclose
package coordinates; set it to `true` only when that network access is acceptable. See
[Code review > Registry verifier](code-review.md#registry-verifier) for
the full verdict matrix.

Environment overrides:

- `CLAWPATCH_STATE_DIR`
- `CLAWPATCH_PROVIDER`
- `CLAWPATCH_MODEL`
- `CLAWPATCH_REASONING_EFFORT`
- `CLAWPATCH_CLAUDE_AUTH_CONTEXT` (`isolated` or `host`; default `isolated`)
- `CLAWPATCH_GIT_PUSH_TIMEOUT_MS` (default `600000`, or 10 minutes)
- `CLAWPATCH_GH_PR_CREATE_TIMEOUT_MS` (default `300000`, or 5 minutes)
- `CLAWPATCH_TASKKILL_TIMEOUT_MS` (Windows cleanup deadline; default `5000`, or 5 seconds)

The `open-pr` timeout overrides must be positive millisecond values. Invalid values fall back to
their defaults.

`CLAWPATCH_TASKKILL_TIMEOUT_MS` must be between `1` and `2147483647` milliseconds;
invalid values fall back to 5 seconds. Fractional values are truncated. Each Windows
process-tree cleanup attempt is bounded independently of the command deadline.
If cleanup fails or times out, Clawpatch also terminates the direct child; descendant
cleanup remains best effort when `taskkill` is unavailable or hung.

`provider.codexConfig` passes primitive values to Codex as `-c key=value`.
Only config loaded by `--config` or `CLAWPATCH_CONFIG` may set non-empty
Codex passthrough config. Auto-discovered repository and state config files
are rejected if they set it, because Codex config can change provider routing
and credential lookup. Keep secrets out of config files; use Codex provider
settings such as `env_key` to read an already-exported environment variable.

`git.commit` and `git.openPr` are reserved config fields. The current CLI does
not commit or open PRs.
