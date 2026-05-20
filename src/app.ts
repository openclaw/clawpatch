import { appendFile, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import {
  changedPathsBetweenSnapshots,
  hasSourceDirtyWorktree,
  sourceChangedSnapshots,
} from "./change-audit.js";
import { loadConfig, resolveStateDir, GlobalOptions } from "./config.js";
import { detectProject } from "./detect.js";
import { ClawpatchError, assertDefined } from "./errors.js";
import { runCommand, runCommandArgs } from "./exec.js";
import {
  appendFindingHistory,
  findingFromOutput,
  mergeFinding,
  parseFindingStatus,
} from "./findings.js";
import { nowIso, writeJson } from "./fs.js";
import { changedFilesSince, dirtyFiles, discoverGit, findProjectRoot } from "./git.js";
import { stableId, runId } from "./id.js";
import { mapWithSource } from "./agent-mapper.js";
import { mapFeatures } from "./mapper.js";
import { emitProgress } from "./progress.js";
import { providerByName, type DroppedFinding } from "./provider.js";
import { buildFixPrompt, buildReviewPromptBundle, buildRevalidatePrompt } from "./prompt.js";
import type { ReviewMode, ReviewPromptManifest } from "./prompt.js";
import {
  evidenceLabel,
  findingSummaries,
  findingSummary,
  renderFindingDetail,
  renderReport,
} from "./reporting.js";
import { validateReviewOutputPartitioned } from "./review-validation.js";
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
  const filters = { include: config.include, exclude: config.exclude };
  emitProgress(context, "map", "start", {
    source,
    existing: existing.length,
    dryRun: flags["dryRun"] === true,
  });
  const heuristic = await mapFeatures(loaded.root, loaded.project, existing, {
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
  const result = await mapWithSource(loaded.root, loaded.project, existing, heuristic, {
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
  if (features.length === 0 && hasFileFilter(flags)) {
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
          for (const dropped of reviewed.droppedFindings) {
            const code = dropped.layer === "validation" ? "validation-drop" : "schema-drop";
            errors.push({
              message:
                `dropped 1 finding from feature ${feature.featureId} ` +
                `at ${dropped.path.join(".")}: ${dropped.message}`,
              code,
              error: null,
            });
          }
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
  const fatalErrors = errors.filter(
    (entry) => entry.code !== "schema-drop" && entry.code !== "validation-drop",
  );
  if (fatalErrors.length > 0) {
    await writeRun(loaded.paths, {
      ...run,
      status: "failed",
      finishedAt: nowIso(),
      findingIds,
      errors: errors.map(({ message, code }) => ({ message, code })),
    });
    emitProgress(context, "review", "failed", {
      run: currentRunId,
      errors: fatalErrors.length,
    });
    throw fatalErrors[0]?.error ?? new ClawpatchError("review failed", 1, "review-failed");
  }
  const finished: RunRecord = {
    ...run,
    status: "completed",
    finishedAt: nowIso(),
    findingIds,
    errors: errors.map(({ message, code }) => ({ message, code })),
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
    const items = findingSummaries(filtered, scopedFeatures);
    return {
      findings: filtered.length,
      total: filtered.length,
      output: outputPath,
      items,
      results: items,
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

async function reviewFeature(
  options: ReviewFeatureOptions,
): Promise<{ findingIds: string[]; droppedFindings: DroppedFinding[] }> {
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
    const reviewPrompt = await buildReviewPromptBundle(
      loaded.root,
      loaded.project,
      lockedFeature,
      config,
      mode,
      customPrompt,
    );
    const providerOutput = await runProviderReviewWithRetry({
      provider,
      root: loaded.root,
      prompt: reviewPrompt.prompt,
      options: providerOptions(config),
      context,
      featureId: feature.featureId,
      index,
      total,
    });
    // Layer 1 drops: per-finding schema violations from parseReviewOutput.
    const droppedFindings: DroppedFinding[] = [...providerOutput.droppedFindings];
    const reviewOutput = {
      findings: reviewFindingsForMode(providerOutput.findings, mode).slice(
        0,
        config.review.maxFindingsPerFeature,
      ),
      inspected: providerOutput.inspected,
    };
    // Layer 2 drops: per-finding evidence validation (line ranges, quotes,
    // included files). Partition so a single bad finding doesn't lose the
    // whole feature.
    const validated = await validateReviewOutputPartitioned(
      loaded.root,
      lockedFeature,
      config,
      reviewPrompt.manifest,
      reviewOutput,
    );
    droppedFindings.push(...validated.droppedFindings);
    const records = validated.findings.map((finding) =>
      findingFromOutput(finding, lockedFeature.featureId, currentRunId),
    );
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
          summary: reviewAnalysisSummary(records.length, reviewPrompt.manifest),
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
    return { findingIds, droppedFindings };
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

type ReviewProvider = ReturnType<typeof providerByName>;
type ProviderReviewOutput = Awaited<ReturnType<ReviewProvider["review"]>>;

async function runProviderReviewWithRetry(args: {
  provider: ReviewProvider;
  root: string;
  prompt: string;
  options: Parameters<ReviewProvider["review"]>[2];
  context: AppContext;
  featureId: string;
  index: number;
  total: number;
}): Promise<ProviderReviewOutput> {
  const { provider, root, prompt, options, context, featureId, index, total } = args;
  const maxAttempts = 1 + reviewRetries();
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await provider.review(root, prompt, options);
    } catch (error: unknown) {
      lastError = error;
      if (!isRetryableReviewError(error) || attempt === maxAttempts) {
        throw error;
      }
      emitProgress(context, "review", "feature-retry", {
        index: index + 1,
        total,
        feature: featureId,
        attempt,
        reason: error instanceof ClawpatchError ? error.code : "unknown",
      });
    }
  }
  throw lastError ?? new ClawpatchError("review retry exhausted", 1, "review-retry-exhausted");
}

function reviewRetries(): number {
  const raw = process.env["CLAWPATCH_REVIEW_RETRIES"];
  if (raw === undefined) {
    return 1;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
}

function isRetryableReviewError(error: unknown): boolean {
  return error instanceof ClawpatchError && error.code === "malformed-output";
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
  if (
    flags["all"] === true ||
    typeof flags["since"] === "string" ||
    flags["includeDirty"] === true
  ) {
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

export async function openPrCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const patchId = assertDefined(stringFlag(flags, "patch"), "missing --patch");
  const patches = await readPatchAttempts(loaded.paths);
  const patch = assertDefined(
    patches.find((candidate) => candidate.patchAttemptId === patchId),
    `patch attempt not found: ${patchId}`,
  );
  const force = flags["force"] === true;
  validatePrPatch(patch, force);
  const git = await discoverGit(loaded.root);
  if (git.root === null) {
    throw new ClawpatchError("open-pr requires a git repository", 2, "not-git-repository");
  }
  const base = stringFlag(flags, "base") ?? git.defaultBranch;
  const branch = prBranchName(patch, stringFlag(flags, "branch"), git.currentBranch, base);
  if (
    flags["dryRun"] !== true &&
    patch.git.prUrl !== null &&
    patch.git.commitSha !== null &&
    patch.git.branchName !== null
  ) {
    return {
      patchAttempt: patch.patchAttemptId,
      branch: patch.git.branchName,
      base,
      commit: patch.git.commitSha,
      pr: patch.git.prUrl,
      next: patch.git.prUrl,
    };
  }
  const findings = await readFindings(loaded.paths);
  const linkedFindings = findings.filter((finding) => patch.findingIds.includes(finding.findingId));
  const title = prTitle(stringFlag(flags, "title"), linkedFindings, patch);
  const body = renderPatchPrBody(patch, linkedFindings);
  const gitFiles = await gitRelativePatchFiles(git.root, loaded.root, patch.filesChanged);
  const draft = flags["draft"] === true;
  const dryRunStagePlan =
    flags["dryRun"] === true && patch.git.commitSha === null
      ? await patchStagePlan(
          git.root,
          await assertPatchWorktree(patch, git.root, loaded.paths.stateDir, gitFiles, force),
        )
      : null;
  const branchExists =
    flags["dryRun"] === true && patch.git.commitSha === null
      ? await localBranchExists(git.root, branch)
      : false;
  const commands = plannedPrCommands(
    patch,
    branch,
    base,
    title,
    gitFiles,
    draft,
    branchExists,
    dryRunStagePlan,
  );
  if (flags["dryRun"] === true) {
    return {
      dryRun: true,
      patchAttempt: patch.patchAttemptId,
      branch,
      base,
      title,
      body,
      commands,
      commandsPreview: commands.join("\n"),
    };
  }

  const patchWorktree = await assertPatchWorktree(
    patch,
    git.root,
    loaded.paths.stateDir,
    gitFiles,
    force,
  );
  let commitSha = patch.git.commitSha;
  const hadRecordedCommit = commitSha !== null;
  if (commitSha === null) {
    const patchBaseSha = assertDefined(patch.git.baseSha, "missing patch base");
    const targetBranchExists = await localBranchExists(git.root, branch);
    if (targetBranchExists) {
      await assertRefAtPatchBase(git.root, branch, patch);
    }
    if (git.currentBranch !== branch) {
      const switchArgs = targetBranchExists
        ? ["switch", branch]
        : ["switch", "-c", branch, patchBaseSha];
      await checkedRun("git switch", runCommandArgs("git", switchArgs, git.root));
    }
    await assertRefAtPatchBase(git.root, "HEAD", patch);
    const stagePlan = await patchStagePlan(git.root, patchWorktree);
    if (stagePlan.addFiles.length > 0) {
      await checkedRun(
        "git add",
        runCommandArgs("git", ["add", "--", ...stagePlan.addFiles.map(gitPathspec)], git.root),
      );
    }
    if (stagePlan.updateFiles.length > 0) {
      await checkedRun(
        "git add -u",
        runCommandArgs(
          "git",
          ["add", "-u", "--", ...stagePlan.updateFiles.map(gitPathspec)],
          git.root,
        ),
      );
    }
    await checkedRun(
      "git commit",
      runCommandArgs(
        "git",
        ["commit", "-m", title, "--", ...stagePlan.commitFiles.map(gitPathspec)],
        git.root,
      ),
    );
    const commit = await checkedRun(
      "git rev-parse",
      runCommandArgs("git", ["rev-parse", "HEAD"], git.root),
    );
    commitSha = commit.stdout.trim();
    await writePatchPrGitState(loaded.paths, patch, {
      commitSha,
      branchName: branch,
      prUrl: patch.git.prUrl,
    });
  }
  commitSha = assertDefined(commitSha, "missing patch commit");
  const pushArgs = hadRecordedCommit
    ? ["push", "origin", `${commitSha}:refs/heads/${branch}`]
    : ["push", "-u", "origin", branch];
  await checkedRun("git push", runCommandArgs("git", pushArgs, git.root));
  const ghArgs = prCreateArgs(base, branch, title, draft);
  const gh = await checkedRun("gh pr create", runCommandArgs(githubCli(), ghArgs, git.root, body));
  const prUrl = firstUrl(gh.stdout) ?? gh.stdout.trim();
  await writePatchPrGitState(loaded.paths, patch, { commitSha, branchName: branch, prUrl });
  return {
    patchAttempt: patch.patchAttemptId,
    branch,
    base,
    commit: commitSha,
    pr: prUrl,
    next: prUrl.length > 0 ? prUrl : "inspect GitHub CLI output",
  };
}

async function writePatchPrGitState(
  paths: ReturnType<typeof statePaths>,
  patch: PatchAttempt,
  git: { commitSha: string; branchName: string; prUrl: string | null },
): Promise<void> {
  await writePatchAttempt(paths, {
    ...patch,
    git: {
      ...patch.git,
      commitSha: git.commitSha,
      branchName: git.branchName,
      prUrl: git.prUrl,
    },
    updatedAt: nowIso(),
  });
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
  for (const flag of ["since", "limit", "jobs"] as const) {
    const value = stringFlag(flags, flag);
    if (value !== undefined) {
      subset[flag] = value;
    }
  }
  if (flags["includeDirty"] === true) {
    subset["includeDirty"] = true;
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

function reviewAnalysisSummary(findings: number, manifest: ReviewPromptManifest): string {
  return [
    `${findings} finding(s)`,
    `prompt=${manifest.promptBytes} bytes`,
    `approxTokens=${manifest.approximateTokens}`,
    `includedFiles=${manifest.includedFiles.length}`,
    `omittedFiles=${manifest.omittedFiles.length}`,
  ].join("; ");
}

function validatePrPatch(patch: PatchAttempt, force: boolean): void {
  if (patch.filesChanged.length === 0) {
    throw new ClawpatchError(
      `patch has no changed files: ${patch.patchAttemptId}`,
      2,
      "invalid-input",
    );
  }
  if (!["applied", "validated"].includes(patch.status) && !force) {
    throw new ClawpatchError(
      `patch is not ready for PR: ${patch.patchAttemptId} (${patch.status})`,
      2,
      "invalid-input",
    );
  }
  const failed = patch.testResults.filter((result) => result.exitCode !== 0);
  if (failed.length > 0 && !force) {
    throw new ClawpatchError(
      `patch validation failed; use --force to open a PR anyway: ${failed[0]?.command ?? "unknown"}`,
      6,
      "validation-failed",
    );
  }
}

function prBranchName(
  patch: PatchAttempt,
  explicit: string | undefined,
  currentBranch: string | null,
  base: string | null,
): string {
  if (explicit !== undefined) {
    return explicit;
  }
  if (base === null) {
    return patch.git.branchName?.startsWith("clawpatch/") === true
      ? patch.git.branchName
      : `clawpatch/${patch.patchAttemptId}`;
  }
  if (
    patch.git.branchName !== null &&
    patch.git.branchName !== base &&
    patch.git.branchName !== "main" &&
    patch.git.branchName !== "master"
  ) {
    return patch.git.branchName;
  }
  if (
    base !== null &&
    currentBranch !== null &&
    currentBranch !== base &&
    currentBranch !== "main" &&
    currentBranch !== "master"
  ) {
    return currentBranch;
  }
  return `clawpatch/${patch.patchAttemptId}`;
}

function prTitle(
  explicit: string | undefined,
  findings: FindingRecord[],
  patch: PatchAttempt,
): string {
  if (explicit !== undefined) {
    return explicit;
  }
  const title = findings[0]?.title ?? patch.plan.split("\n")[0] ?? patch.patchAttemptId;
  return `fix: ${title}`.slice(0, 120);
}

function renderPatchPrBody(patch: PatchAttempt, findings: FindingRecord[]): string {
  const lines = [
    "## Summary",
    "",
    `- patch attempt: \`${patch.patchAttemptId}\``,
    `- status: \`${patch.status}\``,
    `- files changed: ${patch.filesChanged.length}`,
    "",
    "## Findings",
    "",
  ];
  if (findings.length === 0) {
    lines.push("- none linked");
  } else {
    for (const finding of findings) {
      lines.push(`- \`${finding.findingId}\`: ${finding.title} (${finding.severity})`);
    }
  }
  lines.push("", "## Changed Files", "");
  for (const file of patch.filesChanged) {
    lines.push(`- \`${file}\``);
  }
  lines.push("", "## Validation", "");
  const validation = patch.testResults.length > 0 ? patch.testResults : patch.commandsRun;
  if (validation.length === 0) {
    lines.push("- none recorded");
  } else {
    for (const result of validation) {
      lines.push(`- \`${result.command}\` => ${result.exitCode ?? "unknown"}`);
    }
  }
  lines.push("", "## Plan", "", patch.plan, "");
  return `${lines.join("\n")}\n`;
}

async function gitRelativePatchFiles(
  gitRoot: string,
  projectRoot: string,
  files: string[],
): Promise<string[]> {
  const projectPrefix = await gitRelativePathPrefix(gitRoot, projectRoot);
  if (projectPrefix === ".." || projectPrefix.startsWith("../")) {
    throw new ClawpatchError(
      `project root is outside git repository: ${projectRoot}`,
      2,
      "invalid-root",
    );
  }
  const scopedPrefix = isUsableRelativePrefix(projectPrefix) ? projectPrefix : "";
  return files.map((file) => {
    const relativeFile = normalizePath(file);
    if (
      relativeFile.startsWith("../") ||
      relativeFile === ".." ||
      relativeFile.split("/").includes("..") ||
      resolve(relativeFile) === relativeFile ||
      relativeFile.length === 0
    ) {
      throw new ClawpatchError(`patch file escapes git repository: ${file}`, 2, "invalid-input");
    }
    return scopedPrefix.length === 0 ? relativeFile : `${scopedPrefix}/${relativeFile}`;
  });
}

function plannedPrCommands(
  patch: PatchAttempt,
  branch: string,
  base: string | null,
  title: string,
  gitFiles: string[],
  draft: boolean,
  branchExists: boolean,
  stagePlan: PatchStagePlan | null,
): string[] {
  const commands: string[] = [];
  if (patch.git.commitSha === null) {
    const patchBaseSha = assertDefined(patch.git.baseSha, "missing patch base");
    const commitFiles = stagePlan?.commitFiles ?? gitFiles;
    const addFiles = stagePlan?.addFiles ?? gitFiles;
    const updateFiles = stagePlan?.updateFiles ?? [];
    commands.push(
      branchExists
        ? `git switch ${shellArg(branch)}`
        : `git switch -c ${shellArg(branch)} ${shellArg(patchBaseSha)}`,
    );
    if (addFiles.length > 0) {
      commands.push(`git add -- ${shellPathspecArgs(addFiles)}`);
    }
    if (updateFiles.length > 0) {
      commands.push(`git add -u -- ${shellPathspecArgs(updateFiles)}`);
    }
    commands.push(`git commit -m ${shellArg(title)} -- ${shellPathspecArgs(commitFiles)}`);
  }
  commands.push(
    patch.git.commitSha === null
      ? `git push -u origin ${shellArg(branch)}`
      : `git push origin ${shellArg(`${patch.git.commitSha}:refs/heads/${branch}`)}`,
  );
  commands.push(`gh ${prCreateArgs(base, branch, title, draft).map(shellArg).join(" ")}`);
  return commands;
}

function prCreateArgs(
  base: string | null,
  branch: string,
  title: string,
  draft: boolean,
): string[] {
  const args = ["pr", "create", "--head", branch, "--title", title, "--body-file", "-"];
  if (base !== null) {
    args.splice(2, 0, "--base", base);
  }
  if (draft) {
    args.push("--draft");
  }
  return args;
}

async function assertPatchWorktree(
  patch: PatchAttempt,
  gitRoot: string,
  stateDir: string,
  gitFiles: string[],
  force: boolean,
): Promise<{ commitFiles: string[]; stagedOnlyFiles: string[] }> {
  if (patch.git.commitSha !== null) {
    return { commitFiles: gitFiles, stagedOnlyFiles: [] };
  }
  const status = await checkedRun(
    "git status",
    runCommandArgs(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      gitRoot,
      undefined,
      {
        trimOutput: false,
      },
    ),
  );
  const statusChanges = gitStatusChanges(status.stdout);
  const dirty = uniqueStrings(statusChanges.flatMap((change) => change.paths));
  const statePrefix = await gitRelativePathPrefix(gitRoot, stateDir);
  const sourceDirty = dirty.filter((file) => !isStatePath(file, statePrefix));
  if (sourceDirty.length === 0) {
    throw new ClawpatchError("no uncommitted patch changes to commit", 2, "invalid-input");
  }
  const expected = new Set(gitFiles);
  const commitFiles = new Set(gitFiles);
  const stagedOnlyFiles = new Set<string>();
  for (const change of statusChanges) {
    if (change.secondaryPath === undefined) {
      continue;
    }
    if (expected.has(change.primaryPath) || expected.has(change.secondaryPath)) {
      commitFiles.add(change.primaryPath);
      commitFiles.add(change.secondaryPath);
      stagedOnlyFiles.add(change.secondaryPath);
    }
  }
  const extra = sourceDirty.filter((file) => !commitFiles.has(file));
  if (extra.length > 0 && !force) {
    throw new ClawpatchError(
      `dirty worktree has files outside patch attempt: ${extra.join(", ")}`,
      3,
      "dirty-worktree",
    );
  }
  const missing = gitFiles.filter((file) => !sourceDirty.includes(file));
  if (missing.length > 0 && !force) {
    throw new ClawpatchError(
      `patch files are not dirty in the worktree: ${missing.join(", ")}`,
      2,
      "invalid-input",
    );
  }
  return { commitFiles: [...commitFiles], stagedOnlyFiles: [...stagedOnlyFiles] };
}

type PatchStagePlan = {
  commitFiles: string[];
  addFiles: string[];
  updateFiles: string[];
};

async function patchStagePlan(
  root: string,
  patchWorktree: { commitFiles: string[]; stagedOnlyFiles: string[] },
): Promise<PatchStagePlan> {
  const stagedOnlyFiles = new Set(patchWorktree.stagedOnlyFiles);
  const stageableFiles = patchWorktree.commitFiles.filter((file) => !stagedOnlyFiles.has(file));
  const addFiles = await existingGitFiles(root, stageableFiles);
  const updateFiles = stageableFiles.filter((file) => !addFiles.includes(file));
  return { commitFiles: patchWorktree.commitFiles, addFiles, updateFiles };
}

type GitStatusChange = {
  paths: string[];
  primaryPath: string;
  secondaryPath: string | undefined;
};

function gitStatusChanges(output: string): GitStatusChange[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const changes: GitStatusChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    const primaryPath = normalizePath(field.slice(3));
    const paths = [primaryPath];
    let secondaryPath: string | undefined;
    if (/[RC]/u.test(status)) {
      secondaryPath = normalizePath(fields[index + 1] ?? "");
      if (secondaryPath.length > 0) {
        paths.push(secondaryPath);
      }
      index += 1;
    }
    changes.push({ paths, primaryPath, secondaryPath });
  }
  return changes;
}

function isStatePath(file: string, statePrefix: string): boolean {
  return statePrefix.length > 0 && (file === statePrefix || file.startsWith(`${statePrefix}/`));
}

async function gitRelativePathPrefix(gitRoot: string, path: string): Promise<string> {
  const direct = normalizePath(relative(gitRoot, path));
  if (isUsableRelativePrefix(direct)) {
    return direct;
  }
  const [realGitRoot, realPath] = await Promise.all([
    realpath(gitRoot).catch(() => gitRoot),
    realpath(path).catch(() => path),
  ]);
  const resolved = normalizePath(relative(realGitRoot, realPath));
  if (resolved === "" || isUsableRelativePrefix(resolved)) {
    return resolved;
  }
  const normalizedGitRoot = normalizeDarwinPrivateVar(realGitRoot);
  const normalizedPath = normalizeDarwinPrivateVar(realPath);
  if (normalizedPath === normalizedGitRoot) {
    return "";
  }
  if (normalizedPath.startsWith(`${normalizedGitRoot}/`)) {
    return normalizedPath.slice(normalizedGitRoot.length + 1);
  }
  return direct;
}

function isUsableRelativePrefix(path: string): boolean {
  return path.length > 0 && path !== "." && path !== ".." && !path.startsWith("../");
}

async function checkedRun(
  label: string,
  resultPromise: Promise<CommandResult>,
): Promise<CommandResult> {
  const result = await resultPromise;
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      `${label} failed: ${result.stderr || result.stdout}`,
      label.startsWith("gh") ? 7 : 1,
      label.startsWith("gh") ? "github-failure" : "git-failure",
    );
  }
  return result;
}

function githubCli(): string {
  return process.env["CLAWPATCH_GH"] ?? "gh";
}

async function localBranchExists(gitRoot: string, branch: string): Promise<boolean> {
  const result = await runCommandArgs(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    gitRoot,
  );
  return result.exitCode === 0;
}

async function assertRefAtPatchBase(
  gitRoot: string,
  ref: string,
  patch: PatchAttempt,
): Promise<void> {
  const head = await checkedRun(
    "git rev-parse",
    runCommandArgs("git", ["rev-parse", ref], gitRoot),
  );
  const sha = head.stdout.trim();
  if (sha !== patch.git.baseSha) {
    const message = [
      `patch attempt ${patch.patchAttemptId} was recorded from ${patch.git.baseSha},`,
      `but ${ref} is ${sha}`,
    ].join(" ");
    throw new ClawpatchError(message, 2, "invalid-input");
  }
}

function firstUrl(output: string): string | null {
  return /https?:\/\/\S+/u.exec(output)?.[0] ?? null;
}

function gitPathspec(path: string): string {
  return `:(literal)${path}`;
}

function shellPathspecArgs(files: string[]): string {
  return files.map((file) => shellArg(gitPathspec(file))).join(" ");
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "'\\''")}'`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function existingGitFiles(root: string, files: string[]): Promise<string[]> {
  const existing = await Promise.all(
    files.map(async (file) =>
      (await lstat(resolve(root, file)).catch(() => null)) === null ? null : file,
    ),
  );
  return existing.filter((file): file is string => file !== null);
}

function normalizeDarwinPrivateVar(path: string): string {
  return normalizePath(path).replace(/^\/private\/var\//u, "/var/");
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
  if (since === undefined && flags["includeDirty"] !== true) {
    return features;
  }
  const changed = await changedFiles(root, flags);
  return filterFeaturesByChangedFiles(features, changed, true);
}

async function filterFindingsByOwnedFilesSince(
  loaded: Awaited<ReturnType<typeof loadProjectState>>,
  findings: FindingRecord[],
  flags: Record<string, string | boolean>,
): Promise<FindingRecord[]> {
  const since = stringFlag(flags, "since");
  if (since === undefined && flags["includeDirty"] !== true) {
    return findings;
  }
  const changed = await changedFiles(loaded.root, flags);
  const features = await readFeatures(loaded.paths);
  return filterFindingsByChangedOwnedFiles(findings, features, changed);
}

async function changedFiles(
  root: string,
  flags: Record<string, string | boolean>,
): Promise<Set<string>> {
  const changed = new Set<string>();
  const since = stringFlag(flags, "since");
  if (since !== undefined) {
    for (const file of await changedFilesSince(root, since)) {
      changed.add(file);
    }
  }
  if (flags["includeDirty"] === true) {
    for (const file of await dirtyFiles(root)) {
      changed.add(file);
    }
  }
  return changed;
}

function hasFileFilter(flags: Record<string, string | boolean>): boolean {
  return stringFlag(flags, "since") !== undefined || flags["includeDirty"] === true;
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

// eslint-disable-next-line no-underscore-dangle
export const __testing = {
  isRetryableReviewError,
  reviewRetries,
  runProviderReviewWithRetry,
};
