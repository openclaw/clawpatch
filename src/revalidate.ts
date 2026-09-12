import { loadProjectState, type AppContext } from "./app-context.js";
import { filterFindingsByFileFlags } from "./command-selection.js";
import { applyProviderFlags, newRun, providerOptions, stringFlag } from "./command-support.js";
import { ClawpatchError, assertDefined } from "./errors.js";
import { appendFindingHistory } from "./findings.js";
import { refreshFeatureStatuses } from "./feature-status.js";
import { nowIso } from "./fs.js";
import { discoverGit } from "./git.js";
import { runId } from "./id.js";
import { emitProgress } from "./progress.js";
import { providerByName } from "./provider.js";
import { buildRevalidatePrompt } from "./prompt.js";
import { filterFindings } from "./selection.js";
import {
  readFeatures,
  readFinding,
  readFindings,
  readPatchAttempts,
  writeFinding,
  writeRun,
} from "./state.js";
import type { FindingRecord } from "./types.js";

export async function revalidateCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const config = applyProviderFlags(loaded.config, flags);
  const provider = providerByName(config.provider.name);
  const findings = await selectRevalidationFindings(loaded, flags);
  const [features, patchAttempts, allFindings] = await Promise.all([
    readFeatures(loaded.paths),
    readPatchAttempts(loaded.paths),
    readFindings(loaded.paths),
  ]);
  const findingsById = new Map(allFindings.map((finding) => [finding.findingId, finding]));
  const touchedFeatureIds = new Set<string>();
  const currentRunId = runId();
  const currentGit = await discoverGit(loaded.root);
  const run = newRun(currentRunId, "revalidate", loaded.root, currentGit.headSha);
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
      const feature = assertDefined(
        features.find((candidate) => candidate.featureId === finding.featureId),
        `feature not found: ${finding.featureId}`,
      );
      const linkedPatchAttempts = patchAttempts.filter((patch) =>
        finding.linkedPatchAttemptIds.includes(patch.patchAttemptId),
      );
      const prompt = await buildRevalidatePrompt(
        loaded.root,
        finding,
        feature,
        linkedPatchAttempts,
        config,
      );
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
      findingsById.set(updated.findingId, updated);
      touchedFeatureIds.add(updated.featureId);
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
    await refreshFeatureStatuses(
      loaded.paths,
      features,
      [...findingsById.values()],
      touchedFeatureIds,
    );
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
    let statusRefreshError: unknown = null;
    try {
      await refreshFeatureStatuses(
        loaded.paths,
        features,
        [...findingsById.values()],
        touchedFeatureIds,
      );
    } catch (refreshError: unknown) {
      statusRefreshError = refreshError;
    }
    await writeRun(loaded.paths, {
      ...run,
      status: "failed",
      finishedAt: nowIso(),
      findingIds: run.findingIds,
      errors: [
        { message, code: error instanceof ClawpatchError ? error.code : null },
        ...(statusRefreshError === null
          ? []
          : [
              {
                message:
                  statusRefreshError instanceof Error
                    ? statusRefreshError.message
                    : String(statusRefreshError),
                code: statusRefreshError instanceof ClawpatchError ? statusRefreshError.code : null,
              },
            ]),
      ],
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
    const sinceFiltered = await filterFindingsByFileFlags(loaded, filtered, flags);
    const limit = Number(stringFlag(flags, "limit") ?? String(sinceFiltered.length));
    return sinceFiltered.slice(
      0,
      Number.isFinite(limit) && limit > 0 ? limit : sinceFiltered.length,
    );
  }
  return filterFindingsByFileFlags(
    loaded,
    [assertDefined(await readFinding(loaded.paths, findingId), `finding not found: ${findingId}`)],
    flags,
  );
}
