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

export const defaultCommands: ProjectCommands = {
  typecheck: null,
  lint: null,
  format: null,
  test: null,
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
    },
    commands: defaultCommands,
    nativeCommands: null,
    review: {
      maxContextFiles: 24,
      maxOwnedFiles: 12,
      maxFindingsPerFeature: 10,
      minConfidenceToFix: "medium",
    },
    git: {
      requireCleanWorktreeForFix: true,
      commit: false,
      openPr: false,
    },
  };
}

export async function loadConfig(root: string, options: GlobalOptions): Promise<ClawpatchConfig> {
  const configPath = await discoverConfigPath(root, options);
  const base = configPath === null ? defaultConfig() : await readJson(configPath, configSchema);
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

function parseReasoningEffort(value: string | undefined) {
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

async function discoverConfigPath(root: string, options: GlobalOptions): Promise<string | null> {
  if (options.config !== undefined) {
    return resolve(options.config);
  }
  if (process.env["CLAWPATCH_CONFIG"] !== undefined) {
    return resolve(process.env["CLAWPATCH_CONFIG"]);
  }
  const configuredStateDir = options.stateDir ?? process.env["CLAWPATCH_STATE_DIR"];
  const candidates = [
    ...(configuredStateDir === undefined
      ? []
      : [join(resolve(root, configuredStateDir), "config.json")]),
    join(root, "clawpatch.config.json"),
    join(root, ".clawpatch", "config.json"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}
