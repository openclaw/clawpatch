import { loadProjectState, type AppContext } from "./app-context.js";
import {
  changedPathsBetweenSnapshots,
  hasSourceDirtyWorktree,
  sourceChangedSnapshots,
} from "./change-audit.js";
import { applyProviderFlags, providerOptions, stringFlag } from "./command-support.js";
import { ClawpatchError, assertDefined } from "./errors.js";
import { runCommand } from "./exec.js";
import { nowIso } from "./fs.js";
import { discoverGit } from "./git.js";
import { stableId } from "./id.js";
import { providerByName } from "./provider.js";
import { buildFixPrompt } from "./prompt.js";
import { readFeatures, readFinding, writeFinding, writePatchAttempt } from "./state.js";
import type { CommandResult, FindingRecord, FixPlanOutput, PatchAttempt } from "./types.js";
import { validationCommandsForFeature } from "./validation.js";

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
    commandsRun.push(
      await runCommand(command, loaded.root, undefined, {
        timeoutMs: validationTimeoutMs(),
        maxOutputChars: 100_000,
      }),
    );
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

function validationTimeoutMs(): number {
  const configured = Number(process.env["CLAWPATCH_VALIDATION_TIMEOUT_MS"] ?? "600000");
  return Number.isFinite(configured) && configured > 0 ? configured : 600_000;
}
