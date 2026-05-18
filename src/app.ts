import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import {
  changedPathsBetweenSnapshots,
  hasSourceDirtyWorktree,
  sourceChangedSnapshots,
} from "./change-audit.js";
import { loadConfig, resolveStateDir, GlobalOptions } from "./config.js";
import { detectProject } from "./detect.js";
import { ClawpatchError, assertDefined } from "./errors.js";
import { runCommand } from "./exec.js";
import {
  appendFindingHistory,
  findingFromOutput,
  mergeFinding,
  parseFindingStatus,
} from "./findings.js";
import { nowIso, writeJson } from "./fs.js";
import { changedFilesSince, discoverGit, findProjectRoot } from "./git.js";
import { stableId, runId } from "./id.js";
import { mapWithSource } from "./agent-mapper.js";
import { mapFeatures } from "./mapper.js";
import { emitProgress } from "./progress.js";
import { providerByName } from "./provider.js";
import { buildFixPrompt, buildReviewPrompt, buildRevalidatePrompt } from "./prompt.js";
import type { ReviewMode } from "./prompt.js";
import {
  evidenceLabel,
  findingSummaries,
  findingSummary,
  renderFindingDetail,
  renderReport,
} from "./reporting.js";
import {
  filterFeaturesByChangedFiles,
  filterFeaturesByProject,
  filterFindings,
  filterFindingsByChangedOwnedFiles,
  filterFindingsByFeatures,
  limitFeatures,
  nextFinding,
  selectReviewCandidates,
} from "./selection.js";
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
  ReviewOutput,
  RunRecord,
  reasoningEffortSchema,
  reasoningEfforts,
} from "./types.js";
import { validationCommandsForFeature } from "./validation.js";

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
  const source = parseMapSource(flags);
  const config = applyProviderFlags(loaded.config, flags);
  const provider = source === "heuristic" ? null : providerByName(config.provider.name);
  const existing = await readFeatures(loaded.paths);
  emitProgress(context, "map", "start", {
    source,
    existing: existing.length,
    dryRun: flags["dryRun"] === true,
  });
  const heuristic = await mapFeatures(loaded.root, loaded.project, existing, {
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
  const result = await mapWithSource(loaded.root, loaded.project, existing, heuristic, {
    source,
    provider,
    providerOptions: providerOptions(config),
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
  const mode = reviewMode(flags);
  const customPrompt = await loadCustomReviewPrompt(flags);
  const features = await selectReviewFeatures(loaded, flags);
  if (features.length === 0 && typeof flags["since"] === "string") {
    if (flags["dryRun"] === true) {
      return { next: "no features touched by diff" };
    }
    const exportPath = await maybeExportTribunalLedger(
      flags,
      loaded.paths,
      [],
      runId(),
      config.provider.name,
    );
    return {
      ...(exportPath === null ? {} : { exportTribunalLedger: exportPath }),
      next: "no features touched by diff",
    };
  }
  if (flags["dryRun"] === true) {
    return {
      dryRun: true,
      wouldReview: features.length,
      mode,
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
  const errors: Array<{
    message: string;
    code: string | null;
    error: unknown;
  }> = [];
  const jobs = Math.min(reviewJobs(flags), Math.max(features.length, 1));
  let cursor = 0;
  emitProgress(context, "review", "start", {
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
            mode,
            customPrompt,
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
    emitProgress(context, "review", "failed", {
      run: currentRunId,
      errors: errors.length,
    });
    throw errors[0]?.error ?? new ClawpatchError("review failed", 1, "review-failed");
  }
  const finished: RunRecord = {
    ...run,
    status: "completed",
    finishedAt: nowIso(),
    findingIds,
  };
  await writeRun(loaded.paths, finished);
  emitProgress(context, "review", "done", {
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
  const exportPath = await maybeExportTribunalLedger(
    flags,
    loaded.paths,
    findingIds,
    currentRunId,
    config.provider.name,
  );
  return {
    run: currentRunId,
    reviewed: features.length,
    findings: findingIds.length,
    jobs,
    report: reportPath,
    ...(exportPath === null ? {} : { exportTribunalLedger: exportPath }),
    next: findingIds.length > 0 ? `clawpatch fix --finding ${findingIds[0]}` : "clawpatch status",
  };
}

/**
 * Tribunal-style ledger export entry shape. Each line of the emitted
 * JSONL file is one of these. Schema is documented inline so downstream
 * consumers don't need to read clawpatch's source to map their fields:
 *
 *   kind         literal "clawpatch-review" — discriminates from
 *                Tribunal's own "finding" / "resolution" kinds
 *   finding_id   the clawpatch finding ID (stable across runs)
 *   plan_id      always null (clawpatch has no Tribunal plan concept)
 *   round        always 1 (this is the first lens-pass)
 *   agent_pubkey null (Tribunal signs on ingest, not clawpatch)
 *   agent_label  clawpatch-<provider> — gives the consumer a stable
 *                source attribution without leaking model identity
 *   severity     clawpatch's 4-tier severity (consumer maps it)
 *   category     clawpatch's category (consumer maps it)
 *   claim_hash   the clawpatch finding signature (stable dedup key)
 *   claim_uri    null (clawpatch keeps the body internal)
 *   stake        null (clawpatch has no stake economy)
 *   timestamp    finding.updatedAt (ISO-8601)
 *   signature    null (Tribunal signs on ingest)
 *
 * Opt-in only — when --export-tribunal-ledger is omitted nothing is
 * written and no extra work runs.
 */
async function maybeExportTribunalLedger(
  flags: Record<string, string | boolean>,
  paths: ReturnType<typeof statePaths>,
  findingIds: string[],
  currentRunId: string,
  providerName: string,
): Promise<string | null> {
  const path = stringFlag(flags, "exportTribunalLedger");
  if (path === undefined) {
    return null;
  }
  if (path === "") {
    throw new ClawpatchError(
      "--export-tribunal-ledger requires a non-empty path",
      2,
      "invalid-usage",
    );
  }
  const findings = await readFindings(paths);
  const wanted = new Set(findingIds);
  const lines: string[] = [];
  for (const finding of findings) {
    if (!wanted.has(finding.findingId)) {
      continue;
    }
    const entry = {
      kind: "clawpatch-review",
      finding_id: finding.findingId,
      plan_id: null,
      round: 1,
      agent_pubkey: null,
      agent_label: `clawpatch-${providerName}`,
      severity: finding.severity,
      category: finding.category,
      claim_hash: finding.signature,
      claim_uri: null,
      stake: null,
      timestamp: finding.updatedAt,
      signature: null,
      run_id: currentRunId,
    };
    lines.push(JSON.stringify(entry));
  }
  const resolved = resolve(path);
  await writeFile(resolved, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  return resolved;
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
  mode: ReviewMode;
  customPrompt: string | null;
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
    mode,
    customPrompt,
    allowNonPendingFeatureReview,
  } = options;
  const started = Date.now();
  let locked: FeatureRecord | null = null;
  emitProgress(context, "review", "feature-start", {
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
    const prompt = await buildReviewPrompt(
      loaded.root,
      loaded.project,
      lockedFeature,
      config,
      mode,
      customPrompt,
    );
    const output = await provider.review(loaded.root, prompt, providerOptions(config));
    const modeFindings = reviewFindingsForMode(output.findings, mode);
    const records = modeFindings
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
          reasoningEffort: config.provider.reasoningEffort,
          createdAt: nowIso(),
        },
      ],
      updatedAt: nowIso(),
    };
    await writeFeature(loaded.paths, updated);
    await releaseFeatureLock(loaded.paths, lockedFeature.featureId);
    locked = null;
    emitProgress(context, "review", "feature-done", {
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
              reasoningEffort: config.provider.reasoningEffort,
              createdAt: nowIso(),
            },
          ],
          updatedAt: nowIso(),
        });
      } finally {
        await releaseFeatureLock(loaded.paths, locked.featureId);
      }
    }
    emitProgress(context, "review", "feature-error", {
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
  const results: Array<{
    finding: string;
    outcome: FindingRecord["status"];
    reasoning: string;
  }> = [];
  emitProgress(context, "revalidate", "start", {
    run: currentRunId,
    findings: findings.length,
  });
  try {
    for (const [index, finding] of findings.entries()) {
      const started = Date.now();
      emitProgress(context, "revalidate", "finding-start", {
        index: index + 1,
        total: findings.length,
        finding: finding.findingId,
        title: finding.title,
      });
      const prompt = await buildRevalidatePrompt(loaded.root, JSON.stringify(finding, null, 2));
      const output = await provider.revalidate(loaded.root, prompt, providerOptions(config));
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
      emitProgress(context, "revalidate", "finding-done", {
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
    emitProgress(context, "revalidate", "done", {
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
    emitProgress(context, "revalidate", "failed", {
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
  return {
    finding: first.finding,
    outcome: first.outcome,
    reasoning: first.reasoning,
  };
}

export async function fixCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const findingId = assertDefined(stringFlag(flags, "finding"), "missing --finding");
  const config = applyProviderFlags(loaded.config, flags);
  const git = await discoverGit(loaded.root);
  const dirty =
    git.root === null && config.provider.skipGitRepoCheck
      ? false
      : await hasSourceDirtyWorktree(loaded.root, loaded.paths.stateDir);
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
  const prompt = await buildFixPrompt(loaded.root, finding, feature, config);
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
  const beforeChanged =
    (await sourceChangedSnapshots(loaded.root, loaded.paths.stateDir)) ?? new Map();
  let plan: FixPlanOutput;
  try {
    plan = await provider.fix(loaded.root, prompt, providerOptions(config));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await writePatchAttempt(loaded.paths, {
      ...initialPatch,
      status: "failed",
      plan: `${initialPatch.plan}\n\nProvider failed: ${message}`,
      provider: {
        name: provider.name,
        model: config.provider.model,
        reasoningEffort: config.provider.reasoningEffort,
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
  const afterChanged =
    (await sourceChangedSnapshots(loaded.root, loaded.paths.stateDir)) ?? new Map();
  const filesChanged = changedPathsBetweenSnapshots(beforeChanged, afterChanged);
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
      reasoningEffort: config.provider.reasoningEffort,
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
  };
}

function providerOptions(config: ReturnType<typeof applyProviderFlags>) {
  return {
    model: config.provider.model,
    reasoningEffort: config.provider.reasoningEffort,
    skipGitRepoCheck: config.provider.skipGitRepoCheck,
  };
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
    await writeFeature(paths, {
      ...feature,
      status: "fixed",
      updatedAt: nowIso(),
    });
  } else if (hasUnresolved && ["fixed", "revalidated", "reviewed"].includes(feature.status)) {
    await writeFeature(paths, {
      ...feature,
      status: "needs-fix",
      updatedAt: nowIso(),
    });
  }
}

async function selectReviewFeatures(
  loaded: Awaited<ReturnType<typeof loadProjectState>>,
  flags: Record<string, string | boolean>,
): Promise<FeatureRecord[]> {
  const candidates = selectReviewCandidates(await readFeatures(loaded.paths), flags);
  const sinceFiltered = await filterFeaturesByFilesSince(loaded.root, candidates, flags);
  return limitFeatures(sinceFiltered, flags);
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
  return filterFeaturesByChangedFiles(features, changed, true);
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
  return filterFindingsByChangedOwnedFiles(findings, features, changed);
}

function reviewJobs(flags: Record<string, string | boolean>): number {
  const parsed = Number(stringFlag(flags, "jobs") ?? "10");
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(Math.floor(parsed), 32);
}

function reviewMode(flags: Record<string, string | boolean>): ReviewMode {
  const mode = stringFlag(flags, "mode") ?? "default";
  if (mode === "default" || mode === "deslopify") {
    return mode;
  }
  throw new ClawpatchError("invalid --mode; expected default or deslopify", 2, "invalid-usage");
}

async function loadCustomReviewPrompt(
  flags: Record<string, string | boolean>,
): Promise<string | null> {
  const path = stringFlag(flags, "promptFile");
  if (path === undefined) {
    return null;
  }
  if (path === "" || path === "-") {
    return readStdinToString();
  }
  try {
    return await readFile(resolve(path), "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ClawpatchError(
      `failed to read --prompt-file ${path}: ${message}`,
      2,
      "invalid-usage",
    );
  }
}

async function readStdinToString(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new ClawpatchError("--prompt-file=- requested but stdin is a TTY", 2, "invalid-usage");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reviewFindingsForMode(
  findings: ReviewOutput["findings"],
  mode: ReviewMode,
): ReviewOutput["findings"] {
  if (mode !== "deslopify") {
    return findings;
  }
  return findings.filter(
    (finding) => finding.category === "maintainability" || finding.category === "performance",
  );
}
function featureLock(currentRunId: string): NonNullable<FeatureRecord["lock"]> {
  return {
    lockedByRunId: currentRunId,
    lockedAt: nowIso(),
    hostname: hostname(),
    pid: process.pid,
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

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}
