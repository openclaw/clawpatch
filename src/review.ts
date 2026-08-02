import { hostname, cpus } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadProjectState, type AppContext } from "./app-context.js";
import { changedFiles } from "./command-selection.js";
import { applyProviderFlags, newRun, providerOptions, stringFlag } from "./command-support.js";
import { ClawpatchError } from "./errors.js";
import { findingFromOutput, mergeFinding } from "./findings.js";
import { nowIso } from "./fs.js";
import { discoverGit } from "./git.js";
import { runId } from "./id.js";
import { emitProgress } from "./progress.js";
import { providerByName } from "./provider.js";
import type { DroppedFinding } from "./provider-types.js";
import { buildReviewPromptBundle, type ReviewMode, type ReviewPromptManifest } from "./prompt.js";
import { renderReport } from "./reporting.js";
import {
  buildRegistryVerifierValidator,
  validateReviewOutputPartitioned,
  type FindingPostValidator,
  type ValidatePartitionedOptions,
} from "./review-validation.js";
import {
  filterFeaturesByChangedFiles,
  limitFeatures,
  selectReviewCandidates,
  selectFeaturesByIdList,
} from "./selection.js";
import {
  claimFeature,
  readFeatures,
  readFinding,
  readFindings,
  releaseFeatureLock,
  writeFeature,
  writeFinding,
  writeRun,
  type StatePaths,
} from "./state.js";
import type { FeatureRecord, FindingRecord, ReviewOutput, RunRecord } from "./types.js";
import { createRpmLimiter, defaultJobs, rpmFromFlag, type RpmLimiter } from "./rpm-limiter.js";

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
  const limiter = createRpmLimiter(
    rpmFromFlag(stringFlag(flags, "rateLimitPerMinute"), process.env["CLAWPATCH_RPM"]),
  );
  const registryPostValidator = config.registryVerifier.enabled
    ? buildRegistryVerifierValidator()
    : undefined;
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
            limiter,
            registryPostValidator,
            allowNonPendingFeatureReview:
              stringFlag(flags, "feature") !== undefined ||
              stringFlag(flags, "featureList") !== undefined ||
              hasFileFilter(flags),
          });
          findingIds.push(...reviewed.findingIds);
          for (const dropped of reviewed.droppedFindings) {
            const code =
              dropped.layer === "validation"
                ? "validation-drop"
                : dropped.layer === "registry-verifier"
                  ? "registry-verifier-drop"
                  : "schema-drop";
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
    (entry) =>
      entry.code !== "schema-drop" &&
      entry.code !== "validation-drop" &&
      entry.code !== "registry-verifier-drop",
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
  paths: StatePaths,
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
  limiter: RpmLimiter;
  registryPostValidator: FindingPostValidator | undefined;
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
    limiter,
    registryPostValidator,
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
      limiter,
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
    // Layer 3 drops (optional): registry verifier rejects findings whose
    // "package X@Y is unpublished" claim is refuted by the npm registry.
    const validatePartitionedOptions: ValidatePartitionedOptions = {};
    if (registryPostValidator !== undefined) {
      validatePartitionedOptions.postValidator = registryPostValidator;
    }
    const validated = await validateReviewOutputPartitioned(
      loaded.root,
      reviewPrompt.manifest,
      reviewOutput,
      validatePartitionedOptions,
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
  limiter?: RpmLimiter;
}): Promise<ProviderReviewOutput> {
  const { provider, root, prompt, options, context, featureId, index, total, limiter } = args;
  const maxAttempts = 1 + reviewRetries();
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await limiter?.acquire();
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

function reviewAnalysisSummary(findings: number, manifest: ReviewPromptManifest): string {
  return [
    `${findings} finding(s)`,
    `prompt=${manifest.promptBytes} bytes`,
    `approxTokens=${manifest.approximateTokens}`,
    `includedFiles=${manifest.includedFiles.length}`,
    `omittedFiles=${manifest.omittedFiles.length}`,
  ].join("; ");
}

async function selectReviewFeatures(
  loaded: Awaited<ReturnType<typeof loadProjectState>>,
  flags: Record<string, string | boolean>,
): Promise<FeatureRecord[]> {
  const featureListPath = stringFlag(flags, "featureList");
  const features = await readFeatures(loaded.paths);
  if (featureListPath !== undefined) {
    const featureIds = await loadFeatureIdList(featureListPath);
    const selected = selectFeaturesByIdList(features, featureIds);
    const missing = featureIds
      .filter((featureId, index) => featureIds.indexOf(featureId) === index)
      .filter((featureId) => !selected.some((feature) => feature.featureId === featureId));
    if (missing.length > 0) {
      throw new ClawpatchError(
        `unknown feature ids in --feature-list: ${missing.join(", ")}`,
        2,
        "invalid-usage",
      );
    }
    if (selected.length === 0) {
      throw new ClawpatchError(
        "--feature-list did not include any feature ids",
        2,
        "invalid-usage",
      );
    }
    return stringFlag(flags, "limit") === undefined ? selected : limitFeatures(selected, flags);
  }
  const candidates = selectReviewCandidates(features, flags, {
    ignoreStatus: hasFileFilter(flags),
  });
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

export function reviewJobs(
  flags: Record<string, string | boolean>,
  coreCount: number = cpus().length,
): number {
  const explicit = stringFlag(flags, "jobs");
  if (explicit !== undefined) {
    const parsed = Number(explicit);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return 1;
    }
    return Math.min(Math.floor(parsed), 32);
  }
  return defaultJobs(coreCount);
}

function hasFileFilter(flags: Record<string, string | boolean>): boolean {
  return stringFlag(flags, "since") !== undefined || flags["includeDirty"] === true;
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

async function loadFeatureIdList(path: string): Promise<string[]> {
  let contents: string;
  try {
    contents = await readFile(resolve(path), "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ClawpatchError(
      `failed to read --feature-list ${path}: ${message}`,
      2,
      "invalid-usage",
    );
  }
  const featureIds = contents
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (featureIds.length === 0) {
    throw new ClawpatchError("--feature-list did not include any feature ids", 2, "invalid-usage");
  }
  return featureIds;
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

export const reviewTesting = {
  isRetryableReviewError,
  reviewRetries,
  runProviderReviewWithRetry,
};
