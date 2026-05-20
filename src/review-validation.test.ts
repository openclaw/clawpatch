import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import type { ReviewPromptManifest } from "./prompt.js";
import { validateReviewOutput, validateReviewOutputPartitioned } from "./review-validation.js";
import { fixtureRoot, writeFixture } from "./test-helpers.js";
import type { FeatureRecord, ReviewOutput } from "./types.js";

describe("validateReviewOutput", () => {
  it("accepts evidence that points at included files, existing lines, and matching quotes", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-ok-");
    await writeFixture(root, "src/index.ts", "const value = 'TODO_BUG';\n");

    await expect(
      validateReviewOutput(
        root,
        feature("src/index.ts"),
        defaultConfig(),
        manifest("src/index.ts"),
        output("src/index.ts"),
      ),
    ).resolves.toMatchObject({ findings: [{ title: "Bug" }] });
  });

  it("does not reject absolute inspected file metadata", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-inspected-");
    await writeFixture(root, "src/index.ts", "const value = 'TODO_BUG';\n");
    const providerOutput = output("src/index.ts");
    providerOutput.inspected.files = [`${root}/src/index.ts`];

    await expect(
      validateReviewOutput(
        root,
        feature("src/index.ts"),
        defaultConfig(),
        manifest("src/index.ts"),
        providerOutput,
      ),
    ).resolves.toMatchObject({ findings: [{ title: "Bug" }] });
  });

  it("rejects evidence for files that were not included in review context", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-path-");
    await writeFixture(root, "src/index.ts", "const value = 'TODO_BUG';\n");
    await writeFixture(root, "src/other.ts", "const value = 'TODO_BUG';\n");

    await expect(
      validateReviewOutput(
        root,
        feature("src/index.ts"),
        defaultConfig(),
        manifest("src/index.ts"),
        output("src/other.ts"),
      ),
    ).rejects.toMatchObject({ code: "malformed-output" });
  });

  it("rejects stale line ranges and quotes that do not match current file text", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-content-");
    await writeFixture(root, "src/index.ts", "const value = 'real';\n");

    await expect(
      validateReviewOutput(
        root,
        feature("src/index.ts"),
        defaultConfig(),
        manifest("src/index.ts"),
        output("src/index.ts", { startLine: 9, endLine: 9, quote: "real" }),
      ),
    ).rejects.toMatchObject({ code: "malformed-output" });

    await expect(
      validateReviewOutput(
        root,
        feature("src/index.ts"),
        defaultConfig(),
        manifest("src/index.ts"),
        output("src/index.ts", { startLine: 1, endLine: 1, quote: "missing" }),
      ),
    ).rejects.toMatchObject({ code: "malformed-output" });

    await expect(
      validateReviewOutput(
        root,
        feature("src/index.ts"),
        defaultConfig(),
        manifest("src/index.ts"),
        output("src/index.ts", { startLine: 2, endLine: 2, quote: null }),
      ),
    ).rejects.toMatchObject({ code: "malformed-output" });
  });

  it("rejects quotes that only match outside the cited line range", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-line-quote-");
    await writeFixture(root, "src/index.ts", "const first = 'TODO_BUG';\nconst second = 'safe';\n");

    await expect(
      validateReviewOutput(
        root,
        feature("src/index.ts"),
        defaultConfig(),
        manifest("src/index.ts"),
        output("src/index.ts", { startLine: 2, endLine: 2, quote: "TODO_BUG" }),
      ),
    ).rejects.toMatchObject({ code: "malformed-output" });
  });

  it("rejects evidence that only exists beyond the truncated prompt text", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-truncated-");
    await writeFixture(root, "src/index.ts", `${"a".repeat(24_000)}\nconst value = 'TODO_TAIL';\n`);

    await expect(
      validateReviewOutput(
        root,
        feature("src/index.ts"),
        defaultConfig(),
        manifest("src/index.ts", { truncated: true }),
        output("src/index.ts", { startLine: null, endLine: null, quote: "TODO_TAIL" }),
      ),
    ).rejects.toMatchObject({ code: "malformed-output" });
  });
});

describe("validateReviewOutputPartitioned", () => {
  it("returns all findings when every finding's evidence is valid", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-partition-ok-");
    await writeFixture(root, "src/index.ts", "const value = 'TODO_BUG';\n");

    const result = await validateReviewOutputPartitioned(
      root,
      feature("src/index.ts"),
      defaultConfig(),
      manifest("src/index.ts"),
      output("src/index.ts"),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("Bug");
    expect(result.droppedFindings).toEqual([]);
  });

  it("keeps valid siblings when one finding has a stale quote", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-partition-quote-");
    await writeFixture(root, "src/index.ts", "const value = 'TODO_BUG';\n");

    const goodFinding = output("src/index.ts").findings[0]!;
    const badFinding: ReviewOutput["findings"][number] = {
      ...goodFinding,
      title: "Stale quote",
      evidence: [
        {
          path: "src/index.ts",
          startLine: 1,
          endLine: 1,
          symbol: null,
          quote: "this text does not exist",
        },
      ],
    };
    const provider: ReviewOutput = {
      findings: [goodFinding, badFinding, { ...goodFinding, title: "Also good" }],
      inspected: { files: ["src/index.ts"], symbols: [], notes: [] },
    };

    const result = await validateReviewOutputPartitioned(
      root,
      feature("src/index.ts"),
      defaultConfig(),
      manifest("src/index.ts"),
      provider,
    );

    expect(result.findings.map((f) => f.title)).toEqual(["Bug", "Also good"]);
    expect(result.droppedFindings).toHaveLength(1);
    const dropped = result.droppedFindings[0]!;
    expect(dropped.path).toEqual(["findings", 1]);
    expect(dropped.layer).toBe("validation");
    expect(dropped.message).toMatch(/quote/iu);
    expect(dropped.sample.length).toBeLessThanOrEqual(200);
  });

  it("drops findings whose evidence file was not included in the prompt", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-partition-included-");
    await writeFixture(root, "src/index.ts", "const value = 'TODO_BUG';\n");
    await writeFixture(root, "src/other.ts", "const value = 'TODO_BUG';\n");

    const result = await validateReviewOutputPartitioned(
      root,
      feature("src/index.ts"),
      defaultConfig(),
      manifest("src/index.ts"),
      output("src/other.ts"),
    );

    expect(result.findings).toEqual([]);
    expect(result.droppedFindings).toHaveLength(1);
    expect(result.droppedFindings[0]!.layer).toBe("validation");
    expect(result.droppedFindings[0]!.message).toMatch(/not included/iu);
  });

  it("drops findings with empty evidence arrays without throwing", async () => {
    const root = await fixtureRoot("clawpatch-review-validation-partition-empty-");
    await writeFixture(root, "src/index.ts", "const value = 'TODO_BUG';\n");

    const goodFinding = output("src/index.ts").findings[0]!;
    const provider: ReviewOutput = {
      findings: [{ ...goodFinding, title: "No evidence", evidence: [] }, goodFinding],
      inspected: { files: ["src/index.ts"], symbols: [], notes: [] },
    };

    const result = await validateReviewOutputPartitioned(
      root,
      feature("src/index.ts"),
      defaultConfig(),
      manifest("src/index.ts"),
      provider,
    );

    expect(result.findings.map((f) => f.title)).toEqual(["Bug"]);
    expect(result.droppedFindings).toHaveLength(1);
    expect(result.droppedFindings[0]!.path).toEqual(["findings", 0]);
    expect(result.droppedFindings[0]!.message).toMatch(/no evidence/iu);
  });
});

function feature(path: string): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId: "feat_test",
    title: "Test feature",
    summary: "Test feature.",
    kind: "library",
    source: "test",
    confidence: "high",
    entrypoints: [{ path, symbol: null, route: null, command: null }],
    ownedFiles: [{ path, reason: "test" }],
    contextFiles: [],
    tests: [],
    tags: [],
    trustBoundaries: [],
    status: "pending",
    lock: null,
    findingIds: [],
    patchAttemptIds: [],
    analysisHistory: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
  };
}

function output(
  path: string,
  evidence: { startLine?: number | null; endLine?: number | null; quote?: string | null } = {},
): ReviewOutput {
  return {
    findings: [
      {
        title: "Bug",
        category: "bug",
        severity: "medium",
        confidence: "high",
        evidence: [
          {
            path,
            startLine: evidence.startLine ?? 1,
            endLine: evidence.endLine ?? 1,
            symbol: null,
            quote: evidence.quote ?? "TODO_BUG",
          },
        ],
        reasoning: "Reason.",
        reproduction: null,
        recommendation: "Fix it.",
        whyTestsDoNotAlreadyCoverThis: "No test.",
        suggestedRegressionTest: null,
        minimumFixScope: "Small.",
      },
    ],
    inspected: { files: [path], symbols: [], notes: [] },
  };
}

function manifest(
  path: string,
  options: { truncated?: boolean; readable?: boolean } = {},
): ReviewPromptManifest {
  const readable = options.readable ?? true;
  return {
    maxOwnedFiles: defaultConfig().review.maxOwnedFiles,
    maxContextFiles: defaultConfig().review.maxContextFiles,
    includedFiles: [
      {
        path,
        role: "owned",
        bytes: readable ? 1 : 0,
        includedBytes: readable ? 1 : 0,
        truncated: options.truncated ?? false,
        readable,
        skippedReason: readable ? null : "unreadable",
      },
    ],
    omittedFiles: [],
    promptBytes: 1,
    approximateTokens: 1,
  };
}
