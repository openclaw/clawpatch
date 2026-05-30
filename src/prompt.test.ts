import { describe, expect, it } from "vitest";
import {
  REVIEW_PROMPT_FILE_CHAR_LIMIT,
  buildFixPrompt,
  buildReviewPromptBundle,
} from "./prompt.js";
import { defaultConfig } from "./config.js";
import { fixtureRoot, writeFixture } from "./test-helpers.js";
import type { FeatureRecord, FindingRecord, ProjectRecord } from "./types.js";

describe("review prompt provenance", () => {
  it("records included, omitted, and truncated review prompt context", async () => {
    const root = await fixtureRoot("clawpatch-prompt-provenance-");
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    await writeFixture(root, "src/extra.ts", "export const extra = 1;\n");
    await writeFixture(root, "tests/index.test.ts", "expect(1).toBe(1);\n");
    await writeFixture(root, "docs/large.md", `${"x".repeat(24_100)}\n`);
    const bundle = await buildReviewPromptBundle(root, project(root), feature(), {
      ...defaultConfig(),
      review: {
        ...defaultConfig().review,
        maxOwnedFiles: 1,
        maxContextFiles: 2,
      },
    });

    expect(bundle.prompt).toContain("Prompt context:");
    expect(bundle.prompt).toContain("--- src/index.ts (owned, lines 1-1)");
    expect(bundle.prompt).toContain("1 | export const value = 1;");
    expect(bundle.prompt).toContain("--- tests/index.test.ts (context, lines 1-1)");
    expect(bundle.prompt).not.toContain("--- src/extra.ts");
    expect(bundle.prompt).toContain("Valid evidence paths are exactly:");
    expect(bundle.prompt).toContain("- src/index.ts");
    expect(bundle.prompt).toContain("- tests/index.test.ts");
    expect(bundle.prompt).not.toContain("- src/extra.ts");
    expect(bundle.prompt).not.toContain('"analysisHistory"');
    expect(bundle.prompt).not.toContain('"lock"');
    expect(bundle.manifest.includedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/index.ts",
          role: "owned",
          includedStartLine: 1,
          includedEndLine: 1,
          truncated: false,
        }),
        expect.objectContaining({
          path: "docs/large.md",
          role: "context",
          includedStartLine: 1,
          includedEndLine: expect.any(Number),
          truncated: true,
        }),
      ]),
    );
    expect(bundle.manifest.omittedFiles).toEqual([
      { path: "src/extra.ts", role: "owned", reason: "maxOwnedFiles" },
      { path: "docs/omitted.md", role: "context", reason: "maxContextFiles" },
    ]);
    expect(bundle.manifest.promptBytes).toBeGreaterThan(0);
    expect(bundle.manifest.approximateTokens).toBeGreaterThan(0);
  });

  it("marks exact marker-length replacements as truncated", async () => {
    const root = await fixtureRoot("clawpatch-prompt-truncated-edge-");
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    await writeFixture(
      root,
      "docs/large.md",
      `${"x".repeat(REVIEW_PROMPT_FILE_CHAR_LIMIT)}TAIL_ONLY_TOKEN`,
    );
    const bundle = await buildReviewPromptBundle(root, project(root), feature(), defaultConfig());

    expect(bundle.manifest.includedFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "docs/large.md", truncated: true })]),
    );
    expect(bundle.prompt).toContain("--- docs/large.md (context, lines 1-1, truncated)");
    expect(bundle.prompt).toContain("...[truncated after line 1]");
  });

  it("includes linked tests as valid review evidence", async () => {
    const root = await fixtureRoot("clawpatch-prompt-linked-tests-");
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    await writeFixture(root, "src/extra.ts", "export const extra = 1;\n");
    await writeFixture(root, "tests/index.test.ts", "expect(1).toBe(1);\n");
    await writeFixture(root, "docs/large.md", "docs\n");
    const linkedTestFeature = {
      ...feature(),
      contextFiles: [],
      tests: [{ path: "tests/index.test.ts", command: null }],
    };

    const bundle = await buildReviewPromptBundle(
      root,
      project(root),
      linkedTestFeature,
      defaultConfig(),
    );

    expect(bundle.prompt).toContain("--- tests/index.test.ts (test, lines 1-1)");
    expect(bundle.prompt).toContain("- tests/index.test.ts");
    expect(bundle.manifest.includedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tests/index.test.ts", role: "test" }),
      ]),
    );
  });

  it("does not list duplicate-skipped included files as omitted", async () => {
    const root = await fixtureRoot("clawpatch-prompt-duplicate-context-");
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    await writeFixture(root, "src/context-one.ts", "export const one = 1;\n");
    await writeFixture(root, "src/context-two.ts", "export const two = 1;\n");
    await writeFixture(root, "src/context-three.ts", "export const three = 1;\n");
    const duplicateFeature = {
      ...feature(),
      ownedFiles: [{ path: "src/index.ts", reason: "primary" }],
      contextFiles: [
        { path: "src/index.ts", reason: "duplicate owned file" },
        { path: "src/context-one.ts", reason: "context" },
        { path: "src/context-two.ts", reason: "context" },
        { path: "src/context-three.ts", reason: "overflow" },
      ],
    };

    const bundle = await buildReviewPromptBundle(root, project(root), duplicateFeature, {
      ...defaultConfig(),
      review: {
        ...defaultConfig().review,
        maxOwnedFiles: 1,
        maxContextFiles: 2,
      },
    });

    expect(bundle.prompt).toContain("--- src/context-two.ts (context, lines 1-1)");
    expect(bundle.manifest.omittedFiles).toEqual([
      { path: "src/context-three.ts", role: "context", reason: "maxContextFiles" },
    ]);
  });

  it("de-duplicates equivalent prompt paths before applying limits", async () => {
    const root = await fixtureRoot("clawpatch-prompt-normalized-duplicates-");
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    await writeFixture(root, "src/next.ts", "export const next = 1;\n");
    const duplicateFeature = {
      ...feature(),
      ownedFiles: [
        { path: "src/index.ts", reason: "primary" },
        { path: "./src/index.ts", reason: "duplicate spelling" },
        { path: "src/next.ts", reason: "next real file" },
      ],
      contextFiles: [],
    };

    const bundle = await buildReviewPromptBundle(root, project(root), duplicateFeature, {
      ...defaultConfig(),
      review: {
        ...defaultConfig().review,
        maxOwnedFiles: 2,
      },
    });

    expect(bundle.manifest.includedFiles.map((file) => file.path)).toEqual([
      "src/index.ts",
      "src/next.ts",
    ]);
    expect(bundle.manifest.omittedFiles).toEqual([]);
  });

  it("includes fix evidence paths that differ only by normalized spelling", async () => {
    const root = await fixtureRoot("clawpatch-fix-prompt-normalized-evidence-");
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    await writeFixture(root, "src/other.ts", "export const other = 1;\n");
    const normalizedFeature = {
      ...feature(),
      entrypoints: [],
      ownedFiles: [{ path: "./src/index.ts", reason: "primary" }],
      contextFiles: [],
      tests: [],
    };

    const prompt = await buildFixPrompt(root, finding("src/index.ts"), normalizedFeature, {
      ...defaultConfig(),
      review: {
        ...defaultConfig().review,
        maxOwnedFiles: 0,
        maxContextFiles: 0,
      },
    });

    expect(prompt).toContain("--- ./src/index.ts");
    expect(prompt).toContain("export const value = 1;");
    expect(prompt).not.toContain("1 | export const value = 1;");
    expect(prompt).not.toContain("--- src/other.ts");
  });

  it("includes Python runtime syntax guidance in review prompts", async () => {
    const root = await fixtureRoot("clawpatch-prompt-python-runtime-guidance-");
    await writeFixture(
      root,
      "main.py",
      [
        "def parse(value):",
        "    try:",
        "        return float(value)",
        "    except TypeError, ValueError:",
        "        return 0",
        "",
      ].join("\n"),
    );
    await writeFixture(root, ".python-version", "3.14\n");
    const pythonFeature = {
      ...feature(),
      ownedFiles: [{ path: "main.py", reason: "source group root" }],
      contextFiles: [{ path: ".python-version", reason: "python target runtime metadata" }],
      tests: [],
    };

    const bundle = await buildReviewPromptBundle(
      root,
      project(root, ["python"]),
      pythonFeature,
      defaultConfig(),
    );

    expect(bundle.prompt).toContain("Python compatibility guidance:");
    expect(bundle.prompt).toContain(".python-version");
    expect(bundle.prompt).toContain("PEP 758 permits unparenthesized multiple exception types");
    expect(bundle.prompt).toContain("--- .python-version (context, lines 1-1)");
  });
});

function project(root: string, languages: string[] = ["typescript"]): ProjectRecord {
  return {
    schemaVersion: 1,
    projectId: "proj_prompt",
    name: "prompt",
    rootPath: root,
    git: {
      remoteUrl: null,
      defaultBranch: null,
      currentBranch: null,
      headSha: null,
    },
    detected: {
      languages,
      frameworks: [],
      packageManagers: ["npm"],
      commands: defaultConfig().commands,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function feature(): FeatureRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    featureId: "feat_prompt",
    title: "Prompt feature",
    summary: "Prompt provenance feature",
    kind: "library",
    source: "test",
    confidence: "high",
    entrypoints: [],
    ownedFiles: [
      { path: "src/index.ts", reason: "primary" },
      { path: "src/extra.ts", reason: "overflow" },
    ],
    contextFiles: [
      { path: "tests/index.test.ts", reason: "test" },
      { path: "docs/large.md", reason: "large doc" },
      { path: "docs/omitted.md", reason: "overflow" },
    ],
    tests: [],
    tags: [],
    trustBoundaries: [],
    status: "pending",
    lock: null,
    findingIds: [],
    patchAttemptIds: [],
    analysisHistory: [],
    createdAt: now,
    updatedAt: now,
  };
}

function finding(path: string): FindingRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    findingId: "fnd_prompt",
    featureId: "feat_prompt",
    title: "Prompt finding",
    category: "bug",
    severity: "medium",
    confidence: "high",
    triage: "confirmed-bug",
    evidence: [
      {
        path,
        startLine: 1,
        endLine: 1,
        symbol: null,
        quote: null,
      },
    ],
    reasoning: "The file needs a fix.",
    reproduction: null,
    recommendation: "Fix the file.",
    whyTestsDoNotAlreadyCoverThis: "",
    suggestedRegressionTest: null,
    minimumFixScope: "src/index.ts",
    status: "open",
    history: [],
    signature: "sig_prompt",
    linkedPatchAttemptIds: [],
    createdByRunId: "run_prompt",
    createdAt: now,
    updatedAt: now,
  };
}
