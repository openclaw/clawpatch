import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import { loadConfig, resolveStateDir, GlobalOptions } from "./config.js";
import { detectProject } from "./detect.js";
import { ClawpatchError, assertDefined } from "./errors.js";
import { runCommand } from "./exec.js";
import { nowIso, writeJson } from "./fs.js";
import { changedFilesSince, discoverGit, findProjectRoot } from "./git.js";
import { stableId, runId } from "./id.js";
import { mapFeatures } from "./mapper.js";
import { providerByName } from "./provider.js";
import { buildFixPrompt, buildReviewPrompt, buildRevalidatePrompt } from "./prompt.js";
import {
  claimFeature,
  clearFeatureLockFiles,
  ensureStateDirs,
  readFeatures,
  readFeatureLockIds,
  readFinding,
  readFindings,
  readPatchAttempts,
  readProject,
  readRuns,
  statePaths,
  writeFeature,
  writeFinding,
  writePatchAttempt,
  writeProject,
  writeRun,
  releaseFeatureLock,
} from "./state.js";
import {
  CommandResult,
  FeatureRecord,
  FixPlanOutput,
  FindingRecord,
  PatchAttempt,
  RunRecord,
  ReviewOutput,
  deriveFindingTriage,
} from "./types.js";

export type AppContext = {
  root: string;
  options: GlobalOptions;
};

export async function makeContext(options: GlobalOptions): Promise<AppContext> {
  return { root: await findProjectRoot(process.cwd(), options.root), options };
}

export async function initCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const config = await loadConfig(context.root, context.options);
  const stateDir = resolveStateDir(context.root, config);
  const paths = statePaths(stateDir);
  await ensureStateDirs(paths);
  const project = await detectProject(context.root);
  const detectedConfig = { ...config, commands: project.detected.commands };
  const previous = await readProject(paths);
  if (previous !== null && flags["force"] !== true) {
    throw new ClawpatchError("project already initialized; use --force", 2, "already-initialized");
  }
  await writeProject(paths, { ...project, createdAt: previous?.createdAt ?? project.createdAt });
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
  const loaded = await loadProjectState(context);
  const existing = await readFeatures(loaded.paths);
  const result = await mapFeatures(loaded.root, loaded.project, existing);
  const activeFeatureIds = new Set(result.features.map((feature) => feature.featureId));
  if (flags["dryRun"] === true) {
    return {
      dryRun: true,
      features: result.features.length,
      new: result.created,
      changed: result.changed,
      stale: result.stale,
    };
  }
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
  return {
    features: result.features.length,
    new: result.created,
    changed: result.changed,
    stale: result.stale,
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
  return {
    project: loaded.project.name,
    branch: git.currentBranch,
    dirty: git.dirty,
    features: features.length,
    findings: findings.length,
    openFindings: findings.filter((finding) => finding.status === "open").length,
    activeLocks: activeLockIds.size,
    lockFiles: lockFileIds.length,
    lastRun: runs.at(-1)?.runId ?? null,
  };
}

export async function reviewCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const config = applyProviderFlags(loaded.config, flags);
  const provider = providerByName(config.provider.name);
  const features = await selectReviewFeatures(loaded, flags);
  if (features.length === 0 && typeof flags["since"] === "string") {
    return { next: "no features touched by diff" };
  }
  if (flags["dryRun"] === true) {
    return {
      dryRun: true,
      wouldReview: features.length,
      jobs: reviewJobs(flags),
      featureIds: features.map((feature) => feature.featureId),
    };
  }
  const currentRunId = runId();
  const currentGit = await discoverGit(loaded.root);
  const run = newRun(currentRunId, "review", context, loaded.root, currentGit.headSha);
  run.claimedFeatureIds = features.map((feature) => feature.featureId);
  await writeRun(loaded.paths, run);
  const findingIds: string[] = [];
  const errors: Array<{ message: string; code: string | null; error: unknown }> = [];
  const jobs = Math.min(reviewJobs(flags), Math.max(features.length, 1));
  let cursor = 0;
  emitReviewProgress(context, "start", {
    run: currentRunId,
    features: features.length,
    jobs,
  });
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const feature = features[index];
        if (feature === undefined) {
          return;
        }
        try {
          const reviewed = await reviewFeature({
            context,
            loaded,
            config,
            provider,
            feature,
            currentRunId,
            index,
            total: features.length,
            allowNonPendingFeatureReview: stringFlag(flags, "feature") !== undefined,
          });
          findingIds.push(...reviewed.findingIds);
        } catch (error: unknown) {
          errors.push({
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof ClawpatchError ? error.code : null,
            error,
          });
        }
      }
    }),
  );
  if (errors.length > 0) {
    await writeRun(loaded.paths, {
      ...run,
      status: "failed",
      finishedAt: nowIso(),
      findingIds,
      errors: errors.map(({ message, code }) => ({ message, code })),
    });
    emitReviewProgress(context, "failed", { run: currentRunId, errors: errors.length });
    throw errors[0]?.error ?? new ClawpatchError("review failed", 1, "review-failed");
  }
  const finished: RunRecord = {
    ...run,
    status: "completed",
    finishedAt: nowIso(),
    findingIds,
  };
  await writeRun(loaded.paths, finished);
  emitReviewProgress(context, "done", {
    run: currentRunId,
    reviewed: features.length,
    findings: findingIds.length,
  });
  const reportPath = await writeMarkdownReport(
    loaded.paths.reports,
    currentRunId,
    await readFindings(loaded.paths),
    await readFeatures(loaded.paths),
  );
  return {
    run: currentRunId,
    reviewed: features.length,
    findings: findingIds.length,
    jobs,
    report: reportPath,
    next: findingIds.length > 0 ? `clawpatch fix --finding ${findingIds[0]}` : "clawpatch status",
  };
}

export async function reportCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const [findings, features] = await Promise.all([
    readFindings(loaded.paths),
    readFeatures(loaded.paths),
  ]);
  const projectFilter = stringFlag(flags, "project");
  const scopedFeatures = filterFeaturesByProject(features, projectFilter);
  const filtered = filterFindingsByFeatures(
    filterFindings(findings, flags),
    scopedFeatures,
    projectFilter,
  );
  const output = renderReport(filtered, scopedFeatures, {
    includeNext: stringFlag(flags, "status") !== undefined,
  });
  const outputPath = typeof flags["output"] === "string" ? resolve(flags["output"]) : null;
  if (outputPath !== null) {
    await writeFile(outputPath, output, "utf8");
  }
  if (context.options.json) {
    return {
      findings: filtered.length,
      output: outputPath,
      items: findingSummaries(filtered, scopedFeatures),
    };
  }
  return {
    markdown: output,
    output: outputPath,
    findings: filtered.length,
  };
}

export async function showCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const findingId = assertDefined(stringFlag(flags, "finding"), "missing --finding");
  const [finding, features, patches] = await Promise.all([
    readFinding(loaded.paths, findingId),
    readFeatures(loaded.paths),
    readPatchAttempts(loaded.paths),
  ]);
  const record = assertDefined(finding, `finding not found: ${findingId}`);
  const feature = features.find((candidate) => candidate.featureId === record.featureId) ?? null;
  const linkedPatches = patches.filter((patch) => patch.findingIds.includes(record.findingId));
  const validation = validationCommandsForFeature(feature, loaded.config.commands);
  if (context.options.json) {
    return {
      finding: findingSummary(record, feature),
      feature,
      validation,
      patchAttempts: linkedPatches,
      next: `clawpatch triage --finding ${record.findingId} --status <status>`,
    };
  }
  return {
    markdown: renderFindingDetail(record, feature, linkedPatches, validation),
    finding: record.findingId,
  };
}

export async function nextCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const [findings, features] = await Promise.all([
    readFindings(loaded.paths),
    readFeatures(loaded.paths),
  ]);
  const status = stringFlag(flags, "status") ?? "open";
  const projectFilter = stringFlag(flags, "project");
  const scopedFeatures = filterFeaturesByProject(features, projectFilter);
  const selected = nextFinding(
    filterFindingsByFeatures(
      findings.filter((finding) => finding.status === status),
      scopedFeatures,
      projectFilter,
    ),
  );
  if (selected === null) {
    return { finding: null, status, next: "clawpatch report --status open" };
  }
  const feature = features.find((candidate) => candidate.featureId === selected.featureId) ?? null;
  if (context.options.json) {
    return {
      finding: findingSummary(selected, feature),
      next: `clawpatch show --finding ${selected.findingId}`,
    };
  }
  return {
    finding: selected.findingId,
    title: selected.title,
    severity: selected.severity,
    confidence: selected.confidence,
    triage: selected.triage,
    feature: feature?.title ?? selected.featureId,
    evidence: selected.evidence.map(evidenceLabel).join(", ") || "none",
    next: `clawpatch show --finding ${selected.findingId}`,
  };
}

export async function triageCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const findingId = assertDefined(stringFlag(flags, "finding"), "missing --finding");
  const status = parseFindingStatus(assertDefined(stringFlag(flags, "status"), "missing --status"));
  const note = stringFlag(flags, "note") ?? null;
  const finding = assertDefined(
    await readFinding(loaded.paths, findingId),
    `finding not found: ${findingId}`,
  );
  const updated = appendFindingHistory(
    {
      ...finding,
      status,
      updatedAt: nowIso(),
    },
    {
      runId: null,
      kind: "triage",
      status,
      note,
      reasoning: null,
      commands: [],
      createdAt: nowIso(),
    },
  );
  await writeFinding(loaded.paths, updated);
  await refreshFeatureStatus(loaded.paths, finding.featureId);
  return {
    finding: findingId,
    status,
    note,
    next: "clawpatch next",
  };
}

type ReviewFeatureOptions = {
  context: AppContext;
  loaded: Awaited<ReturnType<typeof loadProjectState>>;
  config: ReturnType<typeof applyProviderFlags>;
  provider: ReturnType<typeof providerByName>;
  feature: FeatureRecord;
  currentRunId: string;
  index: number;
  total: number;
  allowNonPendingFeatureReview: boolean;
};

async function reviewFeature(options: ReviewFeatureOptions): Promise<{ findingIds: string[] }> {
  const {
    context,
    loaded,
    config,
    provider,
    feature,
    currentRunId,
    index,
    total,
    allowNonPendingFeatureReview,
  } = options;
  const started = Date.now();
  let locked: FeatureRecord | null = null;
  emitReviewProgress(context, "feature-start", {
    index: index + 1,
    total,
    feature: feature.featureId,
    title: feature.title,
  });
  try {
    const lockedFeature = await claimFeature(
      loaded.paths,
      feature.featureId,
      featureLock(currentRunId),
      {
        allowNonPending: allowNonPendingFeatureReview,
      },
    );
    locked = lockedFeature;
    const prompt = await buildReviewPrompt(loaded.root, loaded.project, lockedFeature, config);
    const output = await provider.review(loaded.root, prompt, config.provider.model);
    const records = output.findings
      .slice(0, config.review.maxFindingsPerFeature)
      .map((finding) => findingFromOutput(finding, lockedFeature.featureId, currentRunId));
    const findingIds: string[] = [];
    for (const finding of records) {
      const existingFinding = await readFinding(loaded.paths, finding.findingId);
      const merged = mergeFinding(existingFinding, finding);
      await writeFinding(loaded.paths, merged);
      findingIds.push(merged.findingId);
    }
    const updated: FeatureRecord = {
      ...lockedFeature,
      status: records.length > 0 ? "needs-fix" : "reviewed",
      lock: null,
      findingIds: Array.from(
        new Set([...lockedFeature.findingIds, ...records.map((finding) => finding.findingId)]),
      ),
      analysisHistory: [
        ...lockedFeature.analysisHistory,
        {
          runId: currentRunId,
          kind: "review",
          summary: `${records.length} finding(s)`,
          provider: provider.name,
          model: config.provider.model,
          createdAt: nowIso(),
        },
      ],
      updatedAt: nowIso(),
    };
    await writeFeature(loaded.paths, updated);
    await releaseFeatureLock(loaded.paths, lockedFeature.featureId);
    locked = null;
    emitReviewProgress(context, "feature-done", {
      index: index + 1,
      total,
      feature: feature.featureId,
      findings: findingIds.length,
      elapsed: `${Math.round((Date.now() - started) / 1000)}s`,
    });
    return { findingIds };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (locked !== null) {
      try {
        await writeFeature(loaded.paths, {
          ...locked,
          status: "error",
          lock: null,
          analysisHistory: [
            ...locked.analysisHistory,
            {
              runId: currentRunId,
              kind: "review-error",
              summary: message,
              provider: provider.name,
              model: config.provider.model,
              createdAt: nowIso(),
            },
          ],
          updatedAt: nowIso(),
        });
      } finally {
        await releaseFeatureLock(loaded.paths, locked.featureId);
      }
    }
    emitReviewProgress(context, "feature-error", {
      index: index + 1,
      total,
      feature: feature.featureId,
      elapsed: `${Math.round((Date.now() - started) / 1000)}s`,
      error: message,
    });
    throw error;
  }
}

export async function revalidateCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const config = applyProviderFlags(loaded.config, flags);
  const provider = providerByName(config.provider.name);
  const findings = await selectRevalidationFindings(loaded, flags);
  const currentRunId = runId();
  const currentGit = await discoverGit(loaded.root);
  const run = newRun(currentRunId, "revalidate", context, loaded.root, currentGit.headSha);
  run.findingIds = findings.map((finding) => finding.findingId);
  await writeRun(loaded.paths, run);
  const results: Array<{ finding: string; outcome: FindingRecord["status"]; reasoning: string }> =
    [];
  emitRevalidateProgress(context, "start", {
    run: currentRunId,
    findings: findings.length,
  });
  try {
    for (const [index, finding] of findings.entries()) {
      const started = Date.now();
      emitRevalidateProgress(context, "finding-start", {
        index: index + 1,
        total: findings.length,
        finding: finding.findingId,
        title: finding.title,
      });
      const prompt = await buildRevalidatePrompt(loaded.root, JSON.stringify(finding, null, 2));
      const output = await provider.revalidate(loaded.root, prompt, config.provider.model);
      const updated = appendFindingHistory(
        {
          ...finding,
          status: output.outcome,
          updatedAt: nowIso(),
        },
        {
          runId: currentRunId,
          kind: "revalidate",
          status: output.outcome,
          note: null,
          reasoning: output.reasoning,
          commands: output.commands,
          createdAt: nowIso(),
        },
      );
      await writeFinding(loaded.paths, updated);
      await refreshFeatureStatus(loaded.paths, finding.featureId);
      results.push({
        finding: finding.findingId,
        outcome: output.outcome,
        reasoning: output.reasoning,
      });
      emitRevalidateProgress(context, "finding-done", {
        index: index + 1,
        total: findings.length,
        finding: finding.findingId,
        outcome: output.outcome,
        elapsed: `${Math.round((Date.now() - started) / 1000)}s`,
      });
    }
    await writeRun(loaded.paths, {
      ...run,
      status: "completed",
      finishedAt: nowIso(),
      findingIds: results.map((result) => result.finding),
    });
    emitRevalidateProgress(context, "done", {
      run: currentRunId,
      revalidated: results.length,
      fixed: results.filter((result) => result.outcome === "fixed").length,
      open: results.filter((result) => result.outcome === "open").length,
      uncertain: results.filter((result) => result.outcome === "uncertain").length,
      falsePositive: results.filter((result) => result.outcome === "false-positive").length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await writeRun(loaded.paths, {
      ...run,
      status: "failed",
      finishedAt: nowIso(),
      findingIds: run.findingIds,
      errors: [{ message, code: error instanceof ClawpatchError ? error.code : null }],
    });
    emitRevalidateProgress(context, "failed", {
      run: currentRunId,
      error: message,
    });
    throw error;
  }
  if (flags["all"] === true || typeof flags["since"] === "string") {
    return {
      revalidated: results.length,
      open: results.filter((result) => result.outcome === "open").length,
      fixed: results.filter((result) => result.outcome === "fixed").length,
      falsePositive: results.filter((result) => result.outcome === "false-positive").length,
      uncertain: results.filter((result) => result.outcome === "uncertain").length,
      next: "clawpatch next",
    };
  }
  const first = assertDefined(results[0], "missing revalidation result");
  return { finding: first.finding, outcome: first.outcome, reasoning: first.reasoning };
}

export async function fixCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const findingId = assertDefined(stringFlag(flags, "finding"), "missing --finding");
  const config = applyProviderFlags(loaded.config, flags);
  const git = await discoverGit(loaded.root);
  const dirty = await hasSourceDirtyWorktree(loaded.root, loaded.paths.stateDir);
  if (config.git.requireCleanWorktreeForFix && dirty && flags["dryRun"] !== true) {
    throw new ClawpatchError(
      "dirty worktree blocks fix; commit/stash first or use --dry-run",
      3,
      "dirty-worktree",
    );
  }
  const finding = assertDefined(
    await readFinding(loaded.paths, findingId),
    `finding not found: ${findingId}`,
  );
  const features = await readFeatures(loaded.paths);
  const feature = assertDefined(
    features.find((candidate) => candidate.featureId === finding.featureId),
    `feature not found: ${finding.featureId}`,
  );
  const patchAttemptId = stableId("pat", [finding.findingId, nowIso()]);
  const provider = providerByName(config.provider.name);
  const createdAt = nowIso();
  const initialPatch: PatchAttempt = {
    schemaVersion: 1,
    patchAttemptId,
    findingIds: [finding.findingId],
    featureIds: [feature.featureId],
    status: "planned",
    plan: `Fix ${finding.title}`,
    filesChanged: [],
    commandsRun: [],
    testResults: [],
    provider: null,
    git: {
      baseSha: git.headSha,
      commitSha: null,
      branchName: git.currentBranch,
      prUrl: null,
    },
    createdAt,
    updatedAt: createdAt,
  };
  const prompt = await buildFixPrompt(loaded.root, finding, feature);
  if (flags["dryRun"] === true) {
    const validationCommands = validationCommandsForFeature(feature, config.commands);
    return {
      finding: finding.findingId,
      dryRun: true,
      patchAttempt: patchAttemptId,
      plan: initialPatch.plan,
      validation: validationCommands.length === 0 ? "none" : validationCommands.join("; "),
    };
  }
  await writePatchAttempt(loaded.paths, initialPatch);
  const startedAt = nowIso();
  const beforeChanged = (await sourceChangedPaths(loaded.root, loaded.paths.stateDir)) ?? new Set();
  let plan: FixPlanOutput;
  try {
    plan = await provider.fix(loaded.root, prompt, config.provider.model);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await writePatchAttempt(loaded.paths, {
      ...initialPatch,
      status: "failed",
      plan: `${initialPatch.plan}\n\nProvider failed: ${message}`,
      provider: {
        name: provider.name,
        model: config.provider.model,
        requestId: null,
        startedAt,
        finishedAt: nowIso(),
      },
      updatedAt: nowIso(),
    });
    await writeFinding(loaded.paths, {
      ...finding,
      linkedPatchAttemptIds: Array.from(
        new Set([...finding.linkedPatchAttemptIds, patchAttemptId]),
      ),
      updatedAt: nowIso(),
    });
    throw error;
  }
  const validationCommands = validationCommandsForFeature(feature, config.commands);
  const commandsRun: CommandResult[] = [];
  for (const command of validationCommands) {
    commandsRun.push(await runCommand(command, loaded.root));
  }
  const afterChanged = (await sourceChangedPaths(loaded.root, loaded.paths.stateDir)) ?? new Set();
  const filesChanged = Array.from(afterChanged).filter((path) => !beforeChanged.has(path));
  const failed = commandsRun.some((result) => result.exitCode !== 0);
  const patch: PatchAttempt = {
    ...initialPatch,
    status: failed ? "failed" : "applied",
    plan: plan.summary,
    filesChanged,
    commandsRun,
    testResults: commandsRun,
    provider: {
      name: provider.name,
      model: config.provider.model,
      requestId: null,
      startedAt,
      finishedAt: nowIso(),
    },
    updatedAt: nowIso(),
  };
  await writePatchAttempt(loaded.paths, patch);
  const updatedFinding: FindingRecord = {
    ...finding,
    linkedPatchAttemptIds: Array.from(new Set([...finding.linkedPatchAttemptIds, patchAttemptId])),
    status: failed ? "open" : "uncertain",
    updatedAt: nowIso(),
  };
  await writeFinding(loaded.paths, updatedFinding);
  if (failed) {
    throw new ClawpatchError("validation failed after applying fix", 6, "validation-failed");
  }
  return {
    finding: finding.findingId,
    dryRun: false,
    patchAttempt: patchAttemptId,
    status: patch.status,
    filesChanged: filesChanged.length,
    changedFiles: filesChanged.length === 0 ? "none" : filesChanged.join(", "),
    commands: commandsRun.length,
    validation:
      commandsRun.length === 0
        ? "none"
        : commandsRun
            .map((result) => `${result.command} => ${result.exitCode ?? "unknown"}`)
            .join("; "),
    next: failed
      ? `inspect ${patchAttemptId}`
      : `clawpatch revalidate --finding ${finding.findingId}`,
  };
}

function mergeFinding(existing: FindingRecord | null, incoming: FindingRecord): FindingRecord {
  if (existing === null) {
    return incoming;
  }
  return {
    ...incoming,
    status: existing.status,
    history: existing.history,
    linkedPatchAttemptIds: existing.linkedPatchAttemptIds,
    createdByRunId: existing.createdByRunId,
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };
}

export async function doctorCommand(
  context: AppContext,
  flags: Record<string, string | boolean> = {},
): Promise<unknown> {
  const loaded = await loadProjectState(context).catch(() => null);
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
  const provider = providerByName(providerName);
  const providerVersion = await provider.check(root);
  return {
    root,
    state: loaded === null ? "missing" : "ok",
    provider: providerName,
    model,
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

async function loadProjectState(context: AppContext) {
  const config = await loadConfig(context.root, context.options);
  const paths = statePaths(resolveStateDir(context.root, config));
  const project = await readProject(paths);
  if (project === null) {
    throw new ClawpatchError("not initialized; run clawpatch init", 2, "not-initialized");
  }
  await ensureStateDirs(paths);
  return { root: context.root, config, paths, project };
}

function applyProviderFlags(
  config: Awaited<ReturnType<typeof loadConfig>>,
  flags: Record<string, string | boolean>,
) {
  const providerName = stringFlag(flags, "provider");
  const model = stringFlag(flags, "model");
  return {
    ...config,
    provider: {
      ...config.provider,
      name: providerName ?? config.provider.name,
      model: model ?? config.provider.model,
    },
  };
}

function validationCommandsForFeature(
  feature: FeatureRecord | null,
  commands: {
    typecheck: string | null;
    lint: string | null;
    format: string | null;
    test: string | null;
  },
): string[] {
  const featureCommands = (feature?.tests ?? []).flatMap((test) =>
    test.command === null || test.command.length === 0 ? [] : [test.command],
  );
  const ordered = [
    commands.format,
    ...featureCommands,
    commands.typecheck,
    commands.lint,
    commands.test,
  ].filter((command): command is string => command !== null && command.length > 0);
  return Array.from(new Set(ordered));
}

async function selectRevalidationFindings(
  loaded: Awaited<ReturnType<typeof loadProjectState>>,
  flags: Record<string, string | boolean>,
): Promise<FindingRecord[]> {
  const findingId = stringFlag(flags, "finding");
  if (flags["all"] === true || findingId === undefined) {
    const filtered = filterFindings(await readFindings(loaded.paths), {
      ...flags,
      status: stringFlag(flags, "status") ?? "open",
    });
    const sinceFiltered = await filterFindingsByOwnedFilesSince(loaded, filtered, flags);
    const limit = Number(stringFlag(flags, "limit") ?? String(sinceFiltered.length));
    return sinceFiltered.slice(
      0,
      Number.isFinite(limit) && limit > 0 ? limit : sinceFiltered.length,
    );
  }
  return filterFindingsByOwnedFilesSince(
    loaded,
    [assertDefined(await readFinding(loaded.paths, findingId), `finding not found: ${findingId}`)],
    flags,
  );
}

async function refreshFeatureStatus(
  paths: ReturnType<typeof statePaths>,
  featureId: string,
): Promise<void> {
  const [features, findings] = await Promise.all([readFeatures(paths), readFindings(paths)]);
  const feature = features.find((candidate) => candidate.featureId === featureId);
  if (feature === undefined) {
    return;
  }
  const featureFindings = findings.filter((finding) => finding.featureId === featureId);
  const hasUnresolved = featureFindings.some((finding) =>
    ["open", "uncertain"].includes(finding.status),
  );
  if (!hasUnresolved && featureFindings.length > 0) {
    await writeFeature(paths, { ...feature, status: "fixed", updatedAt: nowIso() });
  } else if (hasUnresolved && ["fixed", "revalidated", "reviewed"].includes(feature.status)) {
    await writeFeature(paths, { ...feature, status: "needs-fix", updatedAt: nowIso() });
  }
}

function appendFindingHistory(
  finding: FindingRecord,
  entry: FindingRecord["history"][number],
): FindingRecord {
  return { ...finding, history: [...finding.history, entry] };
}

function parseFindingStatus(value: string): FindingRecord["status"] {
  if (
    value === "open" ||
    value === "false-positive" ||
    value === "fixed" ||
    value === "wont-fix" ||
    value === "uncertain"
  ) {
    return value;
  }
  throw new ClawpatchError(`invalid finding status: ${value}`, 2, "invalid-usage");
}

async function hasSourceDirtyWorktree(root: string, stateDir: string): Promise<boolean> {
  const paths = await sourceChangedPaths(root, stateDir);
  return paths === null || paths.size > 0;
}

async function sourceChangedPaths(root: string, stateDir: string): Promise<Set<string> | null> {
  const result = await runCommand("git status --porcelain", root);
  if (result.exitCode !== 0) {
    return null;
  }
  const relativeStateDir = normalizePath(relative(root, stateDir));
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => normalizePath(line.slice(3).trim()))
      .filter((path) => path.length > 0 && !isStatePath(path, relativeStateDir)),
  );
}

function isStatePath(path: string, relativeStateDir: string): boolean {
  if (relativeStateDir === "" || relativeStateDir.startsWith("..")) {
    return false;
  }
  return path === relativeStateDir || path.startsWith(`${relativeStateDir}/`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/$/u, "");
}

async function selectReviewFeatures(
  loaded: Awaited<ReturnType<typeof loadProjectState>>,
  flags: Record<string, string | boolean>,
): Promise<FeatureRecord[]> {
  const candidates = selectReviewCandidates(await readFeatures(loaded.paths), flags);
  const sinceFiltered = await filterFeaturesByFilesSince(loaded.root, candidates, flags);
  return limitFeatures(sinceFiltered, flags);
}

function selectReviewCandidates(
  features: FeatureRecord[],
  flags: Record<string, string | boolean>,
): FeatureRecord[] {
  const featureId = stringFlag(flags, "feature");
  const projectFilter = stringFlag(flags, "project");
  const projectFeatures = filterFeaturesByProject(features, projectFilter);
  const selected =
    featureId === undefined
      ? projectFeatures.filter((feature) => ["pending", "error"].includes(feature.status))
      : projectFeatures.filter((feature) => feature.featureId === featureId);
  return projectFilter === undefined ? selected : selected.toSorted(featureReviewRank);
}

async function filterFeaturesByFilesSince(
  root: string,
  features: FeatureRecord[],
  flags: Record<string, string | boolean>,
): Promise<FeatureRecord[]> {
  const since = stringFlag(flags, "since");
  if (since === undefined) {
    return features;
  }
  const changed = await changedFilesSince(root, since);
  return features.filter((feature) => featureTouchesFiles(feature, changed, true));
}

async function filterFindingsByOwnedFilesSince(
  loaded: Awaited<ReturnType<typeof loadProjectState>>,
  findings: FindingRecord[],
  flags: Record<string, string | boolean>,
): Promise<FindingRecord[]> {
  const since = stringFlag(flags, "since");
  if (since === undefined) {
    return findings;
  }
  const changed = await changedFilesSince(loaded.root, since);
  const features = await readFeatures(loaded.paths);
  const featuresById = new Map(features.map((feature) => [feature.featureId, feature]));
  return findings.filter((finding) => {
    const feature = featuresById.get(finding.featureId);
    return feature !== undefined && featureTouchesFiles(feature, changed, false);
  });
}

function featureTouchesFiles(
  feature: FeatureRecord,
  changed: Set<string>,
  includeContext: boolean,
): boolean {
  const featureFiles = new Set([
    ...feature.ownedFiles.map((file) => file.path),
    ...(includeContext ? feature.contextFiles.map((file) => file.path) : []),
  ]);
  for (const file of changed) {
    if (featureFiles.has(file)) {
      return true;
    }
  }
  return false;
}

function limitFeatures(
  features: FeatureRecord[],
  flags: Record<string, string | boolean>,
): FeatureRecord[] {
  const limit = Number(stringFlag(flags, "limit") ?? "1");
  return features.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 1);
}

function filterFeaturesByProject(
  features: FeatureRecord[],
  project: string | undefined,
): FeatureRecord[] {
  if (project === undefined) {
    return features;
  }
  const normalized = normalizeProjectFilter(project);
  return features.filter((feature) => featureMatchesProject(feature, project, normalized));
}

function filterFindingsByFeatures(
  findings: FindingRecord[],
  features: FeatureRecord[],
  project: string | undefined,
): FindingRecord[] {
  if (project === undefined) {
    return findings;
  }
  const featureIds = new Set(features.map((feature) => feature.featureId));
  return findings.filter((finding) => featureIds.has(finding.featureId));
}

function featureMatchesProject(
  feature: FeatureRecord,
  rawProject: string,
  normalizedProject: string,
): boolean {
  if (
    feature.tags.includes(`project:${rawProject}`) ||
    feature.tags.includes(`project:${normalizedProject}`) ||
    feature.tags.includes(`project-root:${normalizedProject}`)
  ) {
    return true;
  }
  if (normalizedProject === ".") {
    return feature.tags.includes("project-root:.");
  }
  return featurePaths(feature).some(
    (path) => path === normalizedProject || path.startsWith(`${normalizedProject}/`),
  );
}

function featurePaths(feature: FeatureRecord): string[] {
  return [
    ...feature.entrypoints.map((entrypoint) => entrypoint.path),
    ...feature.ownedFiles.map((file) => file.path),
    ...feature.contextFiles.map((file) => file.path),
    ...feature.tests.map((test) => test.path),
  ].map(normalizePath);
}

function normalizeProjectFilter(project: string): string {
  const normalized = normalizePath(project).replace(/^\.\//u, "");
  return normalized.length === 0 ? "." : normalized;
}

function featureReviewRank(left: FeatureRecord, right: FeatureRecord): number {
  return (
    featureStatusRank(left) - featureStatusRank(right) ||
    featureSourceRank(left) - featureSourceRank(right) ||
    left.title.localeCompare(right.title) ||
    left.featureId.localeCompare(right.featureId)
  );
}

function featureStatusRank(feature: FeatureRecord): number {
  return feature.status === "error" ? 0 : 1;
}

function featureSourceRank(feature: FeatureRecord): number {
  if (feature.source.startsWith("next-")) {
    return 0;
  }
  if (feature.source === "package-json-bin") {
    return 1;
  }
  if (feature.source === "node-source-group") {
    return 2;
  }
  if (feature.source === "node-package") {
    return 3;
  }
  return 4;
}

function reviewJobs(flags: Record<string, string | boolean>): number {
  const parsed = Number(stringFlag(flags, "jobs") ?? "10");
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(Math.floor(parsed), 32);
}

function emitReviewProgress(
  context: AppContext,
  event: string,
  fields: Record<string, string | number | boolean>,
): void {
  if (context.options.quiet) {
    return;
  }
  const values = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  process.stderr.write(`clawpatch review ${event}${values.length > 0 ? ` ${values}` : ""}\n`);
}

function emitRevalidateProgress(
  context: AppContext,
  event: string,
  fields: Record<string, string | number | boolean>,
): void {
  if (context.options.quiet) {
    return;
  }
  const values = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  process.stderr.write(`clawpatch revalidate ${event}${values.length > 0 ? ` ${values}` : ""}\n`);
}

function featureLock(currentRunId: string): NonNullable<FeatureRecord["lock"]> {
  return {
    lockedByRunId: currentRunId,
    lockedAt: nowIso(),
    hostname: hostname(),
    pid: process.pid,
  };
}

function findingFromOutput(
  finding: ReviewOutput["findings"][number],
  featureId: string,
  currentRunId: string,
): FindingRecord {
  const signature = stableId("sig", [
    featureId,
    finding.category,
    finding.title,
    JSON.stringify(finding.evidence),
  ]);
  const now = nowIso();
  return {
    schemaVersion: 1,
    findingId: stableId("fnd", [signature]),
    featureId,
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    triage: deriveFindingTriage(finding.category, finding.confidence),
    evidence: finding.evidence,
    reasoning: finding.reasoning,
    reproduction: finding.reproduction,
    recommendation: finding.recommendation,
    whyTestsDoNotAlreadyCoverThis: finding.whyTestsDoNotAlreadyCoverThis,
    suggestedRegressionTest: finding.suggestedRegressionTest,
    minimumFixScope: finding.minimumFixScope,
    status: "open",
    history: [],
    signature,
    linkedPatchAttemptIds: [],
    createdByRunId: currentRunId,
    createdAt: now,
    updatedAt: now,
  };
}

function newRun(
  id: string,
  command: string,
  context: AppContext,
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

async function writeMarkdownReport(
  reportDir: string,
  id: string,
  findings: FindingRecord[],
  features: FeatureRecord[] = [],
): Promise<string> {
  const path = join(reportDir, `${id}.md`);
  await writeFile(path, renderReport(findings, features), "utf8");
  return path;
}

function renderReport(
  findings: FindingRecord[],
  features: FeatureRecord[] = [],
  options: { includeNext?: boolean } = {},
): string {
  const lines = ["# clawpatch report", "", `findings: ${findings.length}`, ""];
  const featureById = new Map(features.map((feature) => [feature.featureId, feature]));
  for (const finding of findings) {
    lines.push(`## ${finding.severity}: ${finding.title}`);
    lines.push("");
    lines.push(`id: ${finding.findingId}`);
    lines.push(`category: ${finding.category}`);
    lines.push(`confidence: ${finding.confidence}`);
    lines.push(`triage: ${finding.triage}`);
    lines.push(`status: ${finding.status}`);
    lines.push(`feature: ${featureLabel(finding.featureId, featureById.get(finding.featureId))}`);
    if (options.includeNext === true) {
      lines.push(`next: clawpatch show --finding ${finding.findingId}`);
    }
    if (finding.evidence.length > 0) {
      lines.push("");
      lines.push("evidence:");
      for (const evidence of finding.evidence) {
        lines.push(`- ${evidenceLabel(evidence)}`);
      }
    }
    lines.push("");
    lines.push(finding.reasoning);
    if (finding.recommendation.length > 0) {
      lines.push("");
      lines.push("recommendation:");
      lines.push(finding.recommendation);
    }
    if (finding.whyTestsDoNotAlreadyCoverThis.length > 0) {
      lines.push("");
      lines.push("test analysis:");
      lines.push(finding.whyTestsDoNotAlreadyCoverThis);
    }
    if (finding.suggestedRegressionTest !== null && finding.suggestedRegressionTest.length > 0) {
      lines.push("");
      lines.push("suggested regression test:");
      lines.push(finding.suggestedRegressionTest);
    }
    if (finding.minimumFixScope.length > 0) {
      lines.push("");
      lines.push("minimum fix scope:");
      lines.push(finding.minimumFixScope);
    }
    if (finding.reproduction !== null && finding.reproduction.length > 0) {
      lines.push("");
      lines.push("repro:");
      lines.push(finding.reproduction);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function renderFindingDetail(
  finding: FindingRecord,
  feature: FeatureRecord | null,
  patches: PatchAttempt[],
  validation: string[],
): string {
  const lines = [`# ${finding.title}`, ""];
  lines.push(`id: ${finding.findingId}`);
  lines.push(`status: ${finding.status}`);
  lines.push(`severity: ${finding.severity}`);
  lines.push(`category: ${finding.category}`);
  lines.push(`confidence: ${finding.confidence}`);
  lines.push(`triage: ${finding.triage}`);
  lines.push(`feature: ${featureLabel(finding.featureId, feature ?? undefined)}`);
  lines.push("");
  lines.push("evidence:");
  for (const evidence of finding.evidence) {
    lines.push(`- ${evidenceLabel(evidence)}`);
  }
  if (finding.evidence.length === 0) {
    lines.push("- none");
  }
  lines.push("");
  lines.push("reasoning:");
  lines.push(finding.reasoning);
  lines.push("");
  lines.push("recommendation:");
  lines.push(finding.recommendation);
  if (finding.whyTestsDoNotAlreadyCoverThis.length > 0) {
    lines.push("");
    lines.push("test analysis:");
    lines.push(finding.whyTestsDoNotAlreadyCoverThis);
  }
  if (finding.suggestedRegressionTest !== null && finding.suggestedRegressionTest.length > 0) {
    lines.push("");
    lines.push("suggested regression test:");
    lines.push(finding.suggestedRegressionTest);
  }
  if (finding.minimumFixScope.length > 0) {
    lines.push("");
    lines.push("minimum fix scope:");
    lines.push(finding.minimumFixScope);
  }
  if (feature !== null) {
    lines.push("");
    lines.push("owned files:");
    for (const file of feature.ownedFiles) {
      lines.push(`- ${file.path}: ${file.reason}`);
    }
    lines.push("");
    lines.push("context files:");
    for (const file of feature.contextFiles) {
      lines.push(`- ${file.path}: ${file.reason}`);
    }
  }
  lines.push("");
  lines.push("validation:");
  for (const command of validation) {
    lines.push(`- ${command}`);
  }
  if (validation.length === 0) {
    lines.push("- none");
  }
  lines.push("");
  lines.push("patch attempts:");
  for (const patch of patches) {
    lines.push(`- ${patch.patchAttemptId}: ${patch.status}`);
  }
  if (patches.length === 0) {
    lines.push("- none");
  }
  lines.push("");
  lines.push("history:");
  for (const entry of finding.history) {
    lines.push(
      `- ${entry.createdAt}: ${entry.kind} ${entry.status ?? ""} ${entry.note ?? ""}`.trim(),
    );
  }
  if (finding.history.length === 0) {
    lines.push("- none");
  }
  lines.push("");
  lines.push(`next: clawpatch triage --finding ${finding.findingId} --status <status>`);
  return `${lines.join("\n")}\n`;
}

function filterFindings(
  findings: FindingRecord[],
  flags: Record<string, string | boolean>,
): FindingRecord[] {
  const status = stringFlag(flags, "status");
  const severity = stringFlag(flags, "severity");
  const feature = stringFlag(flags, "feature");
  const category = stringFlag(flags, "category");
  const triage = stringFlag(flags, "triage");
  return findings.filter(
    (finding) =>
      (status === undefined || finding.status === status) &&
      (severity === undefined || finding.severity === severity) &&
      (feature === undefined || finding.featureId === feature) &&
      (category === undefined || finding.category === category) &&
      (triage === undefined || finding.triage === triage),
  );
}

function nextFinding(findings: FindingRecord[]): FindingRecord | null {
  const ranked = findings.toSorted((a, b) => findingRank(a) - findingRank(b));
  return ranked[0] ?? null;
}

function findingRank(finding: FindingRecord): number {
  const confidenceRank = { high: 0, medium: 1, low: 2 }[finding.confidence];
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 }[finding.severity];
  const bucket =
    finding.triage === "confirmed-bug" && finding.confidence !== "low"
      ? 0
      : ["security", "data-loss", "concurrency"].includes(finding.category)
        ? 1
        : 2;
  return bucket * 1000 + confidenceRank * 100 + severityRank;
}

function findingSummaries(
  findings: FindingRecord[],
  features: FeatureRecord[],
): Array<{
  id: string;
  title: string;
  severity: FindingRecord["severity"];
  category: FindingRecord["category"];
  confidence: FindingRecord["confidence"];
  triage: FindingRecord["triage"];
  status: FindingRecord["status"];
  feature: { id: string; title: string | null };
  evidence: Array<{
    path: string;
    startLine: number | null;
    endLine: number | null;
    symbol: string | null;
  }>;
  recommendation: string;
  reproduction: string | null;
}> {
  const featureById = new Map(features.map((feature) => [feature.featureId, feature]));
  return findings.map((finding) =>
    findingSummary(finding, featureById.get(finding.featureId) ?? null),
  );
}

function findingSummary(
  finding: FindingRecord,
  feature: FeatureRecord | null,
): {
  id: string;
  title: string;
  severity: FindingRecord["severity"];
  category: FindingRecord["category"];
  confidence: FindingRecord["confidence"];
  triage: FindingRecord["triage"];
  status: FindingRecord["status"];
  feature: { id: string; title: string | null };
  evidence: Array<{
    path: string;
    startLine: number | null;
    endLine: number | null;
    symbol: string | null;
  }>;
  recommendation: string;
  reproduction: string | null;
  whyTestsDoNotAlreadyCoverThis: string;
  suggestedRegressionTest: string | null;
  minimumFixScope: string;
  next: string;
} {
  return {
    id: finding.findingId,
    title: finding.title,
    severity: finding.severity,
    category: finding.category,
    confidence: finding.confidence,
    triage: finding.triage,
    status: finding.status,
    feature: {
      id: finding.featureId,
      title: feature?.title ?? null,
    },
    evidence: finding.evidence.map((evidence) => ({
      path: evidence.path,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      symbol: evidence.symbol,
    })),
    recommendation: finding.recommendation,
    reproduction: finding.reproduction,
    whyTestsDoNotAlreadyCoverThis: finding.whyTestsDoNotAlreadyCoverThis,
    suggestedRegressionTest: finding.suggestedRegressionTest,
    minimumFixScope: finding.minimumFixScope,
    next: `clawpatch show --finding ${finding.findingId}`,
  };
}

function evidenceLabel(evidence: FindingRecord["evidence"][number]): string {
  const line =
    evidence.startLine === null
      ? ""
      : evidence.endLine !== null && evidence.endLine !== evidence.startLine
        ? `:${evidence.startLine}-${evidence.endLine}`
        : `:${evidence.startLine}`;
  const symbol = evidence.symbol === null ? "" : ` (${evidence.symbol})`;
  return `${evidence.path}${line}${symbol}`;
}

function featureLabel(featureId: string, feature: FeatureRecord | undefined): string {
  return feature === undefined ? featureId : `${feature.title} (${featureId})`;
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}
