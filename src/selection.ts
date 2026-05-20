import { FeatureRecord, FindingRecord } from "./types.js";

type Flags = Record<string, string | boolean>;

export function selectReviewCandidates(features: FeatureRecord[], flags: Flags): FeatureRecord[] {
  const featureId = stringFlag(flags, "feature");
  const projectFilter = stringFlag(flags, "project");
  const projectFeatures = filterFeaturesByProject(features, projectFilter);
  const selected =
    featureId === undefined
      ? projectFeatures.filter((feature) => ["pending", "error"].includes(feature.status))
      : projectFeatures.filter((feature) => feature.featureId === featureId);
  return projectFilter === undefined ? selected : selected.toSorted(featureReviewRank);
}

export function filterFeaturesByChangedFiles(
  features: FeatureRecord[],
  changed: Set<string>,
  includeContext: boolean,
): FeatureRecord[] {
  return features.filter((feature) => featureTouchesFiles(feature, changed, includeContext));
}

export function filterFindingsByChangedOwnedFiles(
  findings: FindingRecord[],
  features: FeatureRecord[],
  changed: Set<string>,
): FindingRecord[] {
  const featuresById = new Map(features.map((feature) => [feature.featureId, feature]));
  return findings.filter((finding) => {
    const feature = featuresById.get(finding.featureId);
    return feature !== undefined && featureTouchesFiles(feature, changed, false);
  });
}

export function limitFeatures(features: FeatureRecord[], flags: Flags): FeatureRecord[] {
  const explicitLimit = stringFlag(flags, "limit");
  if (explicitLimit === undefined) {
    const unlimited = stringFlag(flags, "since") !== undefined || flags["includeDirty"] === true;
    return features.slice(0, unlimited ? features.length : 1);
  }
  const limit = Number(explicitLimit);
  return features.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 1);
}

export function filterFeaturesByProject(
  features: FeatureRecord[],
  project: string | undefined,
): FeatureRecord[] {
  if (project === undefined) {
    return features;
  }
  const normalized = normalizeProjectFilter(project);
  return features.filter((feature) => featureMatchesProject(feature, project, normalized));
}

export function filterFindingsByFeatures(
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

export function filterFindings(findings: FindingRecord[], flags: Flags): FindingRecord[] {
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

export function nextFinding(findings: FindingRecord[]): FindingRecord | null {
  const ranked = findings.toSorted((a, b) => findingRank(a) - findingRank(b));
  return ranked[0] ?? null;
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
  ].map(normalizeFeaturePath);
}

function normalizeProjectFilter(project: string): string {
  const normalized = normalizeFeaturePath(project).replace(/^\.\//u, "");
  return normalized.length === 0 ? "." : normalized;
}

function normalizeFeaturePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/$/u, "");
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

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}
