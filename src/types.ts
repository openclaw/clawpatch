import { z } from "zod";

export const findingCategories = [
  "bug",
  "security",
  "performance",
  "concurrency",
  "api-contract",
  "data-loss",
  "test-gap",
  "docs-gap",
  "build-release",
  "maintainability",
] as const;

export const findingTriages = [
  "confirmed-bug",
  "contract-mismatch",
  "risk",
  "test-gap",
  "docs-gap",
] as const;

export function deriveFindingTriage(
  category: (typeof findingCategories)[number],
  confidence: "high" | "medium" | "low",
): (typeof findingTriages)[number] {
  if (category === "test-gap") {
    return "test-gap";
  }
  if (category === "docs-gap") {
    return "docs-gap";
  }
  if (category === "api-contract") {
    return "contract-mismatch";
  }
  if (confidence === "high" && ["bug", "security", "data-loss", "concurrency"].includes(category)) {
    return "confirmed-bug";
  }
  return "risk";
}

export const featureKinds = [
  "cli-command",
  "route",
  "ui-flow",
  "service",
  "job",
  "agent-tool",
  "library",
  "config",
  "release",
  "test-suite",
  "infra",
  "unknown",
] as const;

export const featureStatuses = [
  "pending",
  "claimed",
  "reviewed",
  "needs-fix",
  "fixing",
  "fixed",
  "revalidated",
  "skipped",
  "error",
] as const;

export const trustBoundaries = [
  "user-input",
  "network",
  "filesystem",
  "secrets",
  "process-exec",
  "database",
  "auth",
  "permissions",
  "concurrency",
  "external-api",
  "serialization",
] as const;

export const projectCommandsSchema = z.object({
  typecheck: z.string().nullable(),
  lint: z.string().nullable(),
  format: z.string().nullable(),
  test: z.string().nullable(),
});

export type ProjectCommands = z.infer<typeof projectCommandsSchema>;

export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export const reasoningEffortSchema = z.enum(reasoningEfforts);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const projectRecordSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string(),
  name: z.string(),
  rootPath: z.string(),
  git: z.object({
    remoteUrl: z.string().nullable(),
    defaultBranch: z.string().nullable(),
    currentBranch: z.string().nullable(),
    headSha: z.string().nullable(),
  }),
  detected: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    packageManagers: z.array(z.string()),
    commands: projectCommandsSchema,
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  stateDir: z.string(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  provider: z.object({
    name: z.string(),
    model: z.string().nullable(),
    reasoningEffort: reasoningEffortSchema.nullable().optional().default(null),
  }),
  commands: projectCommandsSchema,
  review: z.object({
    maxContextFiles: z.number().int().positive(),
    maxOwnedFiles: z.number().int().positive(),
    maxFindingsPerFeature: z.number().int().positive(),
    minConfidenceToFix: z.enum(["high", "medium", "low"]),
  }),
  git: z.object({
    requireCleanWorktreeForFix: z.boolean(),
    commit: z.boolean(),
    openPr: z.boolean(),
  }),
});

export type ClawpatchConfig = z.infer<typeof configSchema>;

export const featureFileRefSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export const featureEntrypointSchema = z.object({
  path: z.string(),
  symbol: z.string().nullable(),
  route: z.string().nullable(),
  command: z.string().nullable(),
});

export const featureTestRefSchema = z.object({
  path: z.string(),
  command: z.string().nullable(),
});

export const analysisEntrySchema = z.object({
  runId: z.string(),
  kind: z.string(),
  summary: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  reasoningEffort: reasoningEffortSchema.nullable().optional().default(null),
  createdAt: z.string(),
});

export const featureLockSchema = z.object({
  lockedByRunId: z.string(),
  lockedAt: z.string(),
  hostname: z.string(),
  pid: z.number().int(),
});

export const featureRecordSchema = z.object({
  schemaVersion: z.literal(1),
  featureId: z.string(),
  title: z.string(),
  summary: z.string(),
  kind: z.enum(featureKinds),
  source: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  entrypoints: z.array(featureEntrypointSchema),
  ownedFiles: z.array(featureFileRefSchema),
  contextFiles: z.array(featureFileRefSchema),
  tests: z.array(featureTestRefSchema),
  tags: z.array(z.string()),
  trustBoundaries: z.array(z.enum(trustBoundaries)),
  status: z.enum(featureStatuses),
  lock: featureLockSchema.nullable(),
  findingIds: z.array(z.string()),
  patchAttemptIds: z.array(z.string()),
  analysisHistory: z.array(analysisEntrySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type FeatureRecord = z.infer<typeof featureRecordSchema>;
export type FeatureKind = FeatureRecord["kind"];
export type TrustBoundary = FeatureRecord["trustBoundaries"][number];

const evidenceLineSchema = z.number().int().min(0).nullable();

export const evidenceRefSchema = z
  .object({
    path: z.string(),
    startLine: evidenceLineSchema,
    endLine: evidenceLineSchema,
    symbol: z.string().nullable(),
    quote: z.string().nullable(),
  })
  .transform((evidence) =>
    evidence.startLine === 0 || evidence.endLine === 0
      ? { ...evidence, startLine: null, endLine: null }
      : evidence,
  );

export const findingHistoryEntrySchema = z.object({
  runId: z.string().nullable(),
  kind: z.string(),
  status: z.enum(["open", "false-positive", "fixed", "wont-fix", "uncertain"]).nullable(),
  note: z.string().nullable(),
  reasoning: z.string().nullable(),
  commands: z.array(z.string()),
  createdAt: z.string(),
});

export type FindingHistoryEntry = z.infer<typeof findingHistoryEntrySchema>;

export const findingRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    findingId: z.string(),
    featureId: z.string(),
    title: z.string(),
    category: z.enum(findingCategories),
    severity: z.enum(["critical", "high", "medium", "low"]),
    confidence: z.enum(["high", "medium", "low"]),
    triage: z.enum(findingTriages).optional(),
    evidence: z.array(evidenceRefSchema),
    reasoning: z.string(),
    reproduction: z.string().nullable(),
    recommendation: z.string(),
    whyTestsDoNotAlreadyCoverThis: z.string().optional(),
    suggestedRegressionTest: z.string().nullable().optional(),
    minimumFixScope: z.string().optional(),
    status: z.enum(["open", "false-positive", "fixed", "wont-fix", "uncertain"]),
    history: z.array(findingHistoryEntrySchema).optional(),
    signature: z.string(),
    linkedPatchAttemptIds: z.array(z.string()),
    createdByRunId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .transform((finding) => ({
    ...finding,
    triage: finding.triage ?? deriveFindingTriage(finding.category, finding.confidence),
    whyTestsDoNotAlreadyCoverThis: finding.whyTestsDoNotAlreadyCoverThis ?? "",
    suggestedRegressionTest: finding.suggestedRegressionTest ?? null,
    minimumFixScope: finding.minimumFixScope ?? "",
    history: finding.history ?? [],
  }));

export type FindingRecord = z.infer<typeof findingRecordSchema>;

export const commandResultSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type CommandResult = z.infer<typeof commandResultSchema>;

export const patchAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  patchAttemptId: z.string(),
  findingIds: z.array(z.string()),
  featureIds: z.array(z.string()),
  status: z.enum(["planned", "applying", "applied", "validated", "failed", "abandoned"]),
  plan: z.string(),
  filesChanged: z.array(z.string()),
  commandsRun: z.array(commandResultSchema),
  testResults: z.array(commandResultSchema),
  provider: z
    .object({
      name: z.string(),
      model: z.string().nullable(),
      reasoningEffort: reasoningEffortSchema.nullable().optional().default(null),
      requestId: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string(),
    })
    .nullable(),
  git: z.object({
    baseSha: z.string().nullable(),
    commitSha: z.string().nullable(),
    branchName: z.string().nullable(),
    prUrl: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PatchAttempt = z.infer<typeof patchAttemptSchema>;

export const runRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  rootPath: z.string(),
  headSha: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  claimedFeatureIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  patchAttemptIds: z.array(z.string()),
  errors: z.array(
    z.object({
      message: z.string(),
      code: z.string().nullable(),
    }),
  ),
});

export type RunRecord = z.infer<typeof runRecordSchema>;

export const agentMapOutputSchema = z.object({
  features: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      kind: z.enum(featureKinds),
      confidence: z.enum(["high", "medium", "low"]),
      entrypoints: z.array(featureEntrypointSchema),
      ownedFiles: z.array(featureFileRefSchema),
      contextFiles: z.array(featureFileRefSchema),
      tests: z.array(featureTestRefSchema),
      tags: z.array(z.string()),
      trustBoundaries: z.array(z.enum(trustBoundaries)),
      reason: z.string(),
    }),
  ),
  notes: z.array(z.string()),
});

export type AgentMapOutput = z.infer<typeof agentMapOutputSchema>;

export const reviewFindingSchema = z.object({
  title: z.string(),
  category: z.enum(findingCategories),
  severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(evidenceRefSchema),
  reasoning: z.string(),
  reproduction: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  recommendation: z.string(),
  whyTestsDoNotAlreadyCoverThis: z.string(),
  suggestedRegressionTest: z.string().nullable(),
  minimumFixScope: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewInspectedSchema = z.object({
  files: z.array(z.string()),
  symbols: z.array(z.string()),
  notes: z.array(z.string()),
});

export type ReviewInspected = z.infer<typeof reviewInspectedSchema>;

export const reviewOutputSchema = z.object({
  findings: z.array(reviewFindingSchema),
  inspected: reviewInspectedSchema,
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const revalidateOutputSchema = z.object({
  outcome: z.enum(["fixed", "open", "false-positive", "uncertain"]),
  reasoning: z.string(),
  commands: z.array(z.string()),
});

export type RevalidateOutput = z.infer<typeof revalidateOutputSchema>;

export const fixPlanOutputSchema = z.object({
  summary: z.string(),
  findingIds: z.array(z.string()),
  plannedFiles: z.array(z.string()),
  risk: z.enum(["low", "medium", "high"]),
  steps: z.array(z.string()),
  validationCommands: z.array(z.string()),
});

export type FixPlanOutput = z.infer<typeof fixPlanOutputSchema>;
