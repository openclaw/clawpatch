import { FeatureRecord, FindingRecord, PatchAttempt } from "./types.js";

export type FindingSummary = {
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
};

export function renderReport(
  findings: FindingRecord[],
  features: FeatureRecord[] = [],
  options: { includeNext?: boolean } = {},
): string {
  const featureById = new Map(features.map((feature) => [feature.featureId, feature]));
  const clusters = findingClusters(findings);
  const orderedFindings = findings.toSorted(compareFindings);
  const lines = ["# clawpatch report", "", `findings: ${findings.length}`];
  if (clusters.length > 0) {
    lines.push(`clusters: ${clusters.length}`);
  }
  lines.push("");
  if (clusters.length > 0) {
    lines.push("## action clusters");
    lines.push("");
    for (const [index, cluster] of clusters.entries()) {
      lines.push(
        `### cluster ${index + 1}: ${cluster.area} ${cluster.patternLabel} (${cluster.findings.length} findings)`,
      );
      lines.push("");
      for (const finding of cluster.findings) {
        lines.push(
          `- ${finding.severity}/${finding.confidence} ${finding.findingId}: ${finding.title}`,
        );
      }
      lines.push("");
    }
  }
  for (const finding of orderedFindings) {
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

type FindingCluster = {
  area: string;
  pattern: string;
  patternLabel: string;
  findings: FindingRecord[];
};

export function findingClusters(findings: FindingRecord[]): FindingCluster[] {
  const clusterable = findings.filter(isClusterableFinding);
  const groups = new Map<string, FindingCluster>();
  for (const finding of clusterable) {
    const pattern = slopPattern(finding);
    const area = evidenceArea(finding);
    const key = `${pattern.id}:${area}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        area,
        pattern: pattern.id,
        patternLabel: pattern.label,
        findings: [finding],
      });
    } else {
      group.findings.push(finding);
    }
  }
  return [...groups.values()]
    .filter((cluster) => cluster.findings.length > 1)
    .map((cluster) => ({
      ...cluster,
      findings: cluster.findings.toSorted(compareFindings),
    }))
    .toSorted(
      (a, b) =>
        clusterRank(a) - clusterRank(b) ||
        a.area.localeCompare(b.area) ||
        a.pattern.localeCompare(b.pattern),
    );
}

export function renderFindingDetail(
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

export function findingSummaries(
  findings: FindingRecord[],
  features: FeatureRecord[],
): FindingSummary[] {
  const featureById = new Map(features.map((feature) => [feature.featureId, feature]));
  return findings.map((finding) =>
    findingSummary(finding, featureById.get(finding.featureId) ?? null),
  );
}

export function findingSummary(
  finding: FindingRecord,
  feature: FeatureRecord | null,
): FindingSummary {
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

export function evidenceLabel(evidence: FindingRecord["evidence"][number]): string {
  const line =
    evidence.startLine === null
      ? ""
      : evidence.endLine !== null && evidence.endLine !== evidence.startLine
        ? `:${evidence.startLine}-${evidence.endLine}`
        : `:${evidence.startLine}`;
  const symbol = evidence.symbol === null ? "" : ` (${evidence.symbol})`;
  return `${evidence.path}${line}${symbol}`;
}

export function featureLabel(featureId: string, feature: FeatureRecord | undefined): string {
  return feature === undefined ? featureId : `${feature.title} (${featureId})`;
}

function clusterRank(cluster: FindingCluster): number {
  const bestFindingRank = Math.min(...cluster.findings.map(findingReportRank));
  return bestFindingRank * 1000 - cluster.findings.length;
}

function isClusterableFinding(finding: FindingRecord): boolean {
  return finding.category === "maintainability" || finding.category === "performance";
}

function findingReportRank(finding: FindingRecord): number {
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 }[finding.severity];
  const confidenceRank = { high: 0, medium: 1, low: 2 }[finding.confidence];
  return severityRank * 100 + confidenceRank * 10;
}

function compareFindings(a: FindingRecord, b: FindingRecord): number {
  return (
    findingReportRank(a) - findingReportRank(b) ||
    a.title.localeCompare(b.title) ||
    a.findingId.localeCompare(b.findingId)
  );
}

function evidenceArea(finding: FindingRecord): string {
  const path = finding.evidence[0]?.path ?? finding.featureId;
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return parts[0] ?? "unknown";
  }
  if (parts.length === 2) {
    return parts[0] ?? "unknown";
  }
  return `${parts[0]}/${parts[1]}`;
}

function slopPattern(finding: FindingRecord): { id: string; label: string } {
  const text = `${finding.title} ${finding.reasoning} ${finding.recommendation}`.toLowerCase();
  if (hasAny(text, ["duplicate", "duplicated", "copy", "copied", "repeated", "parallel"])) {
    return { id: "duplication", label: "duplication" };
  }
  if (hasAny(text, ["wrapper", "pass-through", "forward", "alias", "shim"])) {
    return { id: "wrapper", label: "wrapper bloat" };
  }
  if (hasAny(text, ["boilerplate", "generated", "registry", "manual", "bloat", "mass"])) {
    return { id: "bloat", label: "code bloat" };
  }
  if (hasAny(text, ["test", "fixture", "fake", "mock", "harness"])) {
    return { id: "test", label: "test coupling" };
  }
  if (isBandAidPattern(text)) {
    return { id: "band-aid", label: "band-aid" };
  }
  if (hasAny(text, ["try/catch", "fallback", "warning", "suppress", "swallow", "defensive"])) {
    return { id: "defensive", label: "defensive bloat" };
  }
  if (hasAny(text, ["dead", "unused", "obsolete", "legacy", "deprecated", "no-op"])) {
    return { id: "dead", label: "dead code" };
  }
  if (finding.category === "performance") {
    return { id: "performance", label: "performance waste" };
  }
  return { id: "slop", label: "slop cleanup" };
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function isBandAidPattern(text: string): boolean {
  return (
    hasAny(text, [
      "type-ignore",
      "timeout",
      "sleep",
      "sys.path",
      "silenc",
      " as any",
      ": any",
      "<any>",
      "any[]",
      "array<any",
    ]) || /\bany\b/.test(text)
  );
}
