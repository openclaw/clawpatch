import { ClawpatchError } from "./errors.js";
import { stableId } from "./id.js";
import { deriveFindingTriage, FindingRecord, ReviewOutput } from "./types.js";
import { nowIso } from "./fs.js";

export function mergeFinding(
  existing: FindingRecord | null,
  incoming: FindingRecord,
): FindingRecord {
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

export function appendFindingHistory(
  finding: FindingRecord,
  entry: FindingRecord["history"][number],
): FindingRecord {
  return { ...finding, history: [...finding.history, entry] };
}

export function parseFindingStatus(value: string): FindingRecord["status"] {
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

export function findingFromOutput(
  finding: ReviewOutput["findings"][number],
  featureId: string,
  currentRunId: string,
): FindingRecord {
  const signature = stableId("sig", [
    featureId,
    finding.category,
    finding.title,
    canonicalEvidence(finding.evidence),
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

type CanonicalEvidenceRef = {
  path: string;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
  quote: string | null;
};

function canonicalEvidence(finding: ReviewOutput["findings"][number]["evidence"]): string {
  return JSON.stringify(
    finding
      .map((evidence): CanonicalEvidenceRef => ({
        path: evidence.path,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        symbol: evidence.symbol,
        quote: evidence.quote,
      }))
      .toSorted(compareCanonicalEvidence),
  );
}

function compareCanonicalEvidence(left: CanonicalEvidenceRef, right: CanonicalEvidenceRef): number {
  return (
    compareStrings(left.path, right.path) ||
    compareNullableNumbers(left.startLine, right.startLine) ||
    compareNullableNumbers(left.endLine, right.endLine) ||
    compareNullableStrings(left.symbol, right.symbol) ||
    compareNullableStrings(left.quote, right.quote)
  );
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  return left - right;
}

function compareNullableStrings(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
