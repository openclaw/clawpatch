import { join, resolve } from "node:path";
import {
  ClawpatchConfig,
  configSchema,
  ProjectCommands,
  reasoningEffortSchema,
  reasoningEfforts,
} from "./types.js";
import { ClawpatchError } from "./errors.js";
import { pathExists, readJson } from "./fs.js";

export type GlobalOptions = {
  root?: string;
  stateDir?: string;
  config?: string;
  json: boolean;
  plain: boolean;
  quiet: boolean;
  verbose: boolean;
  debug: boolean;
  noColor: boolean;
  noInput: boolean;
};

type ConfigSource = "option" | "env" | "state-dir" | "project" | "state";

type ConfigDiscovery = {
  path: string;
  source: ConfigSource;
};

export function defaultConfig(): ClawpatchConfig {
  return {
    schemaVersion: 1,
    stateDir: ".clawpatch",
    include: ["**/*"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "target/**",
      ".build/**",
      ".git/**",
      ".clawpatch/**",
    ],
    provider: {
      name: "codex",
      model: null,
      reasoningEffort: null,
      codexConfig: {},
    },
    commands: defaultCommands(),
    review: {
      maxContextFiles: 24,
      maxOwnedFiles: 12,
      maxPromptBytes: 180_000,
      maxFindingsPerFeature: 10,
      minConfidenceToFix: "medium",
    },
    git: {
      requireCleanWorktreeForFix: true,
      commit: false,
      openPr: false,
    },
    registryVerifier: {
      enabled: false,
    },
  };
}

export async function loadConfig(root: string, options: GlobalOptions): Promise<ClawpatchConfig> {
  const discovery = await discoverConfigPath(root, options);
  const base = discovery === null ? defaultConfig() : await readJson(discovery.path, configSchema);
  assertTrustedCodexConfig(base, discovery?.source ?? null);
  return {
    ...base,
    stateDir: options.stateDir ?? process.env["CLAWPATCH_STATE_DIR"] ?? base.stateDir,
    provider: {
      ...base.provider,
      name: process.env["CLAWPATCH_PROVIDER"] ?? base.provider.name,
      model: process.env["CLAWPATCH_MODEL"] ?? base.provider.model,
      reasoningEffort:
        parseReasoningEffort(process.env["CLAWPATCH_REASONING_EFFORT"]) ??
        base.provider.reasoningEffort,
    },
  };
}

export function resolveStateDir(root: string, config: ClawpatchConfig): string {
  return resolve(root, config.stateDir);
}

export function parseReasoningEffort(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = reasoningEffortSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new ClawpatchError(
    `invalid reasoning effort: ${value}; expected ${reasoningEfforts.join(", ")}`,
    2,
    "invalid-usage",
  );
}

function defaultCommands(): ProjectCommands {
  return {
    typecheck: null,
    lint: null,
    format: null,
    test: null,
  };
}

function assertTrustedCodexConfig(config: ClawpatchConfig, source: ConfigSource | null): void {
  if (Object.keys(config.provider.codexConfig).length === 0) {
    return;
  }
  if (source === "option" || source === "env") {
    return;
  }
  throw new ClawpatchError(
    "provider.codexConfig may only be set from --config or CLAWPATCH_CONFIG; repository and state config cannot control Codex provider settings",
    2,
    "invalid-usage",
  );
}

async function discoverConfigPath(
  root: string,
  options: GlobalOptions,
): Promise<ConfigDiscovery | null> {
  if (options.config !== undefined) {
    return { path: resolve(options.config), source: "option" };
  }
  if (process.env["CLAWPATCH_CONFIG"] !== undefined) {
    return { path: resolve(process.env["CLAWPATCH_CONFIG"]), source: "env" };
  }
  const configuredStateDir = options.stateDir ?? process.env["CLAWPATCH_STATE_DIR"];
  const candidates: ConfigDiscovery[] = [
    ...(configuredStateDir === undefined
      ? []
      : [
          {
            path: join(resolve(root, configuredStateDir), "config.json"),
            source: "state-dir" as const,
          },
        ]),
    { path: join(root, "clawpatch.config.json"), source: "project" },
    { path: join(root, ".clawpatch", "config.json"), source: "state" },
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate.path)) {
      return candidate;
    }
  }
  return null;
}
