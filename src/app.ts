import { appendFile } from "node:fs/promises";
import { loadConfig, parseReasoningEffort, resolveStateDir } from "./config.js";
import { applyProviderFlags, providerOptions, stringFlag } from "./command-support.js";
import { loadProjectState, type AppContext } from "./app-context.js";
import { detectProject } from "./detect.js";
import { ClawpatchError } from "./errors.js";
import { nowIso, writeJson } from "./fs.js";
import { discoverGit } from "./git.js";
import { mapWithSource } from "./agent-mapper.js";
import { mapFeatures } from "./mapper.js";
import { emitProgress } from "./progress.js";
import { providerByName } from "./provider.js";
import {
  clearFeatureLockFiles,
  ensureStateDirs,
  readFeatures,
  readFeatureLockIds,
  readFindings,
  readProject,
  readRuns,
  statePaths,
  writeFeature,
  writeProject,
} from "./state.js";
import { reviewCommand, reviewTesting } from "./review.js";
import { reportCommand } from "./finding-commands.js";

export { makeContext, type AppContext } from "./app-context.js";
export { openPrCommand } from "./open-pr.js";
export { revalidateCommand } from "./revalidate.js";
export { fixCommand } from "./fix.js";
export { reviewCommand, reviewJobs } from "./review.js";
export { nextCommand, reportCommand, showCommand, triageCommand } from "./finding-commands.js";

export async function initCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const config = await loadConfig(context.root, context.options);
  const stateDir = resolveStateDir(context.root, config);
  const paths = statePaths(stateDir);
  await ensureStateDirs(paths);
  const project = await detectProject(context.root);
  const detectedConfig = {
    ...config,
    provider: {
      ...config.provider,
      codexConfig: {},
    },
    commands: project.detected.commands,
  };
  const previous = await readProject(paths);
  if (previous !== null && flags["force"] !== true) {
    throw new ClawpatchError("project already initialized; use --force", 2, "already-initialized");
  }
  await writeProject(paths, {
    ...project,
    createdAt: previous?.createdAt ?? project.createdAt,
  });
  if (previous === null || flags["force"] === true) {
    await writeJson(paths.config, detectedConfig);
  }
  return {
    created: previous === null,
    project,
    paths: [paths.project, paths.config],
    next: "clawpatch map",
  };
}

export async function mapCommand(
  context: AppContext,
  flags: Record<string, string | boolean> = {},
): Promise<unknown> {
  const started = Date.now();
  const loaded = await loadProjectState(context);
  const detectedProject = await detectProject(loaded.root);
  const project = { ...detectedProject, createdAt: loaded.project.createdAt };
  const source = parseMapSource(flags);
  const config = applyProviderFlags(loaded.config, flags);
  const provider = source === "heuristic" ? null : providerByName(config.provider.name);
  const existing = await readFeatures(loaded.paths);
  const filters = { include: config.include, exclude: config.exclude };
  emitProgress(context, "map", "start", {
    source,
    existing: existing.length,
    dryRun: flags["dryRun"] === true,
  });
  const heuristic = await mapFeatures(loaded.root, project, existing, {
    filters,
    onProgress: (event) => {
      emitProgress(context, "map", event.event, {
        mapper: event.mapper,
        ...(event.seeds === undefined ? {} : { seeds: event.seeds }),
        ...(event.elapsedMs === undefined
          ? {}
          : { elapsed: `${Math.round(event.elapsedMs / 1000)}s` }),
      });
    },
  });
  emitProgress(context, "map", "heuristic-done", {
    features: heuristic.features.length,
    new: heuristic.created,
    changed: heuristic.changed,
    stale: heuristic.stale,
  });
  const result = await mapWithSource(loaded.root, project, existing, heuristic, {
    source,
    provider,
    providerOptions: providerOptions(config),
    inventory: filters,
    onProgress: (event, fields) => {
      emitProgress(context, "map", event, fields);
    },
  });
  const activeFeatureIds = new Set(result.features.map((feature) => feature.featureId));
  if (flags["dryRun"] === true) {
    emitProgress(context, "map", "done", {
      features: result.features.length,
      usedAgent: result.decision.usedAgent,
      elapsed: `${Math.round((Date.now() - started) / 1000)}s`,
    });
    return {
      dryRun: true,
      features: result.features.length,
      new: result.created,
      changed: result.changed,
      stale: result.stale,
      source: result.decision.source,
      usedAgent: result.decision.usedAgent,
      reason: result.decision.reason,
    };
  }
  emitProgress(context, "map", "write-start", {
    features: result.features.length,
  });
  await writeProject(loaded.paths, project);
  for (const feature of result.features) {
    await writeFeature(loaded.paths, feature);
  }
  for (const feature of existing) {
    if (!activeFeatureIds.has(feature.featureId)) {
      await writeFeature(loaded.paths, {
        ...feature,
        status: "skipped",
        lock: null,
        updatedAt: nowIso(),
      });
    }
  }
  emitProgress(context, "map", "done", {
    features: result.features.length,
    usedAgent: result.decision.usedAgent,
    elapsed: `${Math.round((Date.now() - started) / 1000)}s`,
  });
  return {
    features: result.features.length,
    new: result.created,
    changed: result.changed,
    stale: result.stale,
    source: result.decision.source,
    usedAgent: result.decision.usedAgent,
    reason: result.decision.reason,
    next: "clawpatch review --limit 3",
  };
}

export async function statusCommand(context: AppContext): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const [features, findings, runs, git, lockFileIds] = await Promise.all([
    readFeatures(loaded.paths),
    readFindings(loaded.paths),
    readRuns(loaded.paths),
    discoverGit(loaded.root),
    readFeatureLockIds(loaded.paths),
  ]);
  const activeLockIds = new Set(
    features.flatMap((feature) => (feature.lock === null ? [] : [feature.featureId])),
  );
  for (const id of lockFileIds) {
    activeLockIds.add(id);
  }
  const activeFeatures = features.filter((feature) => feature.status !== "skipped");
  return {
    project: loaded.project.name,
    branch: git.currentBranch,
    dirty: git.dirty,
    features: activeFeatures.length,
    staleFeatures: features.length - activeFeatures.length,
    findings: findings.length,
    openFindings: findings.filter((finding) => finding.status === "open").length,
    activeLocks: activeLockIds.size,
    lockFiles: lockFileIds.length,
    lastRun: runs.at(-1)?.runId ?? null,
  };
}

export async function ciCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const initialized = await ensureInitialized(context);
  const mapFlags = providerFlagSubset(flags);
  const reviewFlags = reviewFlagSubset(flags);
  const mapped = await mapCommand(context, mapFlags);
  const reviewed = await reviewCommand(context, reviewFlags);
  const reportFlags = reportFlagSubset(flags);
  const report = (await reportCommand(context, reportFlags)) as {
    findings?: number;
    output?: string | null;
    markdown?: string;
  };
  const reviewFindings = numberField(reviewed, "findings") ?? 0;
  const summary = renderCiSummary({ initialized, mapped, reviewed, reviewFindings, report });
  const githubStepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (githubStepSummary !== undefined && githubStepSummary.length > 0) {
    await appendFile(githubStepSummary, summary, "utf8");
  }
  return {
    initialized,
    mapped: numberField(mapped, "features"),
    reviewed: numberField(reviewed, "reviewed") ?? 0,
    findings: reviewFindings,
    reportFindings: report.findings ?? 0,
    report: report.output ?? null,
    githubStepSummary: githubStepSummary ?? null,
    next: stringField(reviewed, "next") ?? "clawpatch status",
  };
}

export async function doctorCommand(
  context: AppContext,
  flags: Record<string, string | boolean> = {},
): Promise<unknown> {
  let loaded: Awaited<ReturnType<typeof loadProjectState>> | null;
  try {
    loaded = await loadProjectState(context);
  } catch (error) {
    if (error instanceof ClawpatchError && error.code === "not-initialized") {
      loaded = null;
    } else {
      throw error;
    }
  }
  const root = loaded?.root ?? context.root;
  const providerName =
    stringFlag(flags, "provider") ??
    process.env["CLAWPATCH_PROVIDER"] ??
    loaded?.config.provider.name ??
    "codex";
  const model =
    stringFlag(flags, "model") ??
    process.env["CLAWPATCH_MODEL"] ??
    loaded?.config.provider.model ??
    null;
  const reasoningEffort =
    parseReasoningEffort(stringFlag(flags, "reasoningEffort")) ??
    parseReasoningEffort(process.env["CLAWPATCH_REASONING_EFFORT"]) ??
    loaded?.config.provider.reasoningEffort ??
    null;
  const provider = providerByName(providerName);
  const providerVersion = await provider.check(root);
  return {
    root,
    state: loaded === null ? "missing" : "ok",
    provider: providerName,
    model,
    reasoningEffort,
    providerVersion,
    secrets: "redacted",
  };
}

export async function cleanLocksCommand(context: AppContext): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const features = await readFeatures(loaded.paths);
  let cleared = 0;
  for (const feature of features) {
    if (feature.lock === null) {
      continue;
    }
    await writeFeature(loaded.paths, {
      ...feature,
      status: feature.status === "claimed" ? "pending" : feature.status,
      lock: null,
      updatedAt: nowIso(),
    });
    cleared += 1;
  }
  const lockFilesCleared = await clearFeatureLockFiles(loaded.paths);
  return { cleared, lockFilesCleared };
}

async function ensureInitialized(context: AppContext): Promise<boolean> {
  const config = await loadConfig(context.root, context.options);
  const paths = statePaths(resolveStateDir(context.root, config));
  if ((await readProject(paths)) !== null) {
    await ensureStateDirs(paths);
    return false;
  }
  await initCommand(context, {});
  return true;
}

function providerFlagSubset(
  flags: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const subset: Record<string, string | boolean> = {};
  for (const flag of ["provider", "model", "reasoningEffort"] as const) {
    const value = stringFlag(flags, flag);
    if (value !== undefined) {
      subset[flag] = value;
    }
  }
  if (flags["skipGitRepoCheck"] === true) {
    subset["skipGitRepoCheck"] = true;
  }
  return subset;
}

function reviewFlagSubset(
  flags: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const subset = providerFlagSubset(flags);
  for (const flag of ["since", "limit", "jobs", "rateLimitPerMinute"] as const) {
    const value = stringFlag(flags, flag);
    if (value !== undefined) {
      subset[flag] = value;
    }
  }
  if (flags["includeDirty"] === true) {
    subset["includeDirty"] = true;
  }
  if (flags["noRegistryVerify"] === true) {
    subset["noRegistryVerify"] = true;
  }
  return subset;
}

function reportFlagSubset(flags: Record<string, string | boolean>): Record<string, string> {
  const output = stringFlag(flags, "output");
  return output === undefined ? {} : { output };
}

function renderCiSummary(input: {
  initialized: boolean;
  mapped: unknown;
  reviewed: unknown;
  reviewFindings: number;
  report: { findings?: number; output?: string | null };
}): string {
  const lines = [
    "## Clawpatch review",
    "",
    `- initialized: ${input.initialized ? "yes" : "no"}`,
    `- mapped features: ${numberField(input.mapped, "features") ?? "unknown"}`,
    `- reviewed features: ${numberField(input.reviewed, "reviewed") ?? 0}`,
    `- findings: ${input.reviewFindings}`,
  ];
  if (input.report.findings !== undefined && input.report.findings !== input.reviewFindings) {
    lines.push(`- report findings: ${input.report.findings}`);
  }
  if (input.report.output !== undefined && input.report.output !== null) {
    lines.push(`- report: ${input.report.output}`);
  }
  const next = stringField(input.reviewed, "next");
  if (next !== undefined) {
    lines.push(`- next: \`${next}\``);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function numberField(value: unknown, field: string): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "number" ? candidate : null;
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
}

function parseMapSource(flags: Record<string, string | boolean>): "heuristic" | "auto" | "agent" {
  const source = stringFlag(flags, "source") ?? "heuristic";
  if (source === "heuristic" || source === "auto" || source === "agent") {
    return source;
  }
  throw new ClawpatchError(
    "invalid --source; expected heuristic, auto, or agent",
    2,
    "invalid-usage",
  );
}

// eslint-disable-next-line no-underscore-dangle
export const __testing = {
  ...reviewTesting,
  reviewFlagSubset,
};
