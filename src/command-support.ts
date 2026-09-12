import { loadConfig, parseReasoningEffort } from "./config.js";
import { nowIso } from "./fs.js";
import type { RunRecord } from "./types.js";

export type CommandFlags = Record<string, string | boolean>;

export function stringFlag(flags: CommandFlags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function applyProviderFlags(
  config: Awaited<ReturnType<typeof loadConfig>>,
  flags: CommandFlags,
) {
  const providerName = stringFlag(flags, "provider");
  const model = stringFlag(flags, "model");
  const reasoningEffort = parseReasoningEffort(stringFlag(flags, "reasoningEffort"));
  return {
    ...config,
    provider: {
      ...config.provider,
      name: providerName ?? config.provider.name,
      model: model ?? config.provider.model,
      reasoningEffort: reasoningEffort ?? config.provider.reasoningEffort,
      skipGitRepoCheck: flags["skipGitRepoCheck"] === true,
    },
    registryVerifier: {
      ...config.registryVerifier,
      enabled: flags["noRegistryVerify"] === true ? false : config.registryVerifier.enabled,
    },
  };
}

export function providerOptions(config: ReturnType<typeof applyProviderFlags>) {
  return {
    model: config.provider.model,
    reasoningEffort: config.provider.reasoningEffort,
    codexConfig: config.provider.codexConfig,
    skipGitRepoCheck: config.provider.skipGitRepoCheck,
  };
}

export function newRun(
  id: string,
  command: string,
  root: string,
  headSha: string | null,
): RunRecord {
  return {
    schemaVersion: 1,
    runId: id,
    command,
    args: process.argv.slice(2),
    rootPath: root,
    headSha,
    startedAt: nowIso(),
    finishedAt: null,
    status: "running",
    claimedFeatureIds: [],
    findingIds: [],
    patchAttemptIds: [],
    errors: [],
  };
}
