import { describe, expect, it } from "vitest";
import {
  REVIEW_PROMPT_FILE_CHAR_LIMIT,
  buildFixPrompt,
  buildRevalidatePrompt,
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

  it("compacts revalidation feature metadata before provider submission", async () => {
    const root = await fixtureRoot("clawpatch-revalidate-prompt-budget-");
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const largeFeature: FeatureRecord = {
      ...feature(),
      ownedFiles: [{ path: "src/index.ts", reason: "primary" }],
      contextFiles: Array.from({ length: 2_500 }, (_, index) => ({
        path: `docs/context-${index}.md`,
        reason: `context ${"x".repeat(300)}`,
      })),
      tests: Array.from({ length: 200 }, (_, index) => ({
        path: `tests/context-${index}.test.ts`,
        command: null,
      })),
      findingIds: Array.from({ length: 200 }, (_, index) => `fnd_large_${index}`),
      patchAttemptIds: Array.from({ length: 200 }, (_, index) => `patch_large_${index}`),
      analysisHistory: Array.from({ length: 40 }, (_, index) => ({
        runId: `run_large_${index}`,
        kind: "review",
        summary: `large analysis ${"x".repeat(1_000)}`,
        provider: "codex",
        model: null,
        reasoningEffort: null,
        createdAt: new Date(2026, 0, index + 1).toISOString(),
      })),
    };
    const largeFinding: FindingRecord = {
      ...finding("src/index.ts"),
      history: Array.from({ length: 40 }, (_, index) => ({
        runId: `run_history_${index}`,
        kind: "revalidate",
        status: "open",
        note: null,
        reasoning: `large history ${"x".repeat(1_000)}`,
        commands: [],
        createdAt: new Date(2026, 0, index + 1).toISOString(),
      })),
    };
    const config = defaultConfig();
    config.review.maxOwnedFiles = 10_000;
    config.review.maxContextFiles = 10_000;

    const prompt = await buildRevalidatePrompt(root, largeFinding, largeFeature, [], config);

    expect(prompt.length).toBeLessThan(1_048_576);
    expect(prompt).toContain('"omittedContextFiles": 2450');
    expect(prompt).toContain('"omittedTests": 150');
    expect(prompt).toContain('"omittedFindingIds": 150');
    expect(prompt).toContain('"omittedPatchAttemptIds": 150');
    expect(prompt).toContain('"omittedAnalysisHistory": 37');
    expect(prompt).toContain('"omittedHistory": 35');
    expect(prompt).toContain("--- src/index.ts");
    expect(prompt).not.toContain('"path": "docs/context-2499.md"');
    expect(prompt).not.toContain("large analysis 0");
    expect(prompt).not.toContain("large history 0");
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

  it("includes shell fallback output ambiguity guidance in review prompts", async () => {
    const root = await fixtureRoot("clawpatch-prompt-shell-fallback-");
    await writeFixture(
      root,
      "scripts/check-status.sh",
      [
        "#!/usr/bin/env bash",
        'status="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || echo 000)"',
        'echo "status=$status"',
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      ".github/workflows/status.yml",
      [
        "name: status",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        '          some_command || echo "failed"',
        "",
      ].join("\n"),
    );
    const shellFeature = {
      ...feature(),
      title: "Shell/workflow config check-status.sh",
      summary: "Shell or workflow automation with captured machine-readable output.",
      kind: "config" as const,
      source: "shell-workflow-heuristic",
      ownedFiles: [{ path: "scripts/check-status.sh", reason: "shell workflow automation" }],
      contextFiles: [
        { path: ".github/workflows/status.yml", reason: "workflow run-block context" },
      ],
      tags: ["config", "shell", "workflow"],
      trustBoundaries: ["process-exec", "network"] as FeatureRecord["trustBoundaries"],
    };

    const bundle = await buildReviewPromptBundle(
      root,
      project(root, ["shell", "yaml"]),
      shellFeature,
      defaultConfig(),
    );

    expect(bundle.prompt).toContain("Shell and workflow review:");
    expect(bundle.prompt).toContain(
      'status="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || echo 000)"',
    );
    expect(bundle.prompt).toContain("404000");
    expect(bundle.prompt).toContain('some_command || echo "failed"');
    expect(bundle.prompt).toContain('if ! status="$(cmd)"; then status="fallback"; fi');
    expect(bundle.prompt).toContain("--- scripts/check-status.sh (owned");
    expect(bundle.prompt).toContain("--- .github/workflows/status.yml (context");
  });
});

describe("CUDA prompt guidance", () => {
  it("includes CUDA review guidance for a feature that owns a .cu file", async () => {
    const root = await fixtureRoot("clawpatch-prompt-cuda-review-");
    await writeFixture(root, "src/kernel.cu", "__global__ void k(void) {}\n");
    const cudaFeature: FeatureRecord = {
      ...feature(),
      entrypoints: [],
      ownedFiles: [{ path: "src/kernel.cu", reason: "kernel" }],
      contextFiles: [],
    };
    const bundle = await buildReviewPromptBundle(root, project(root), cudaFeature, defaultConfig());

    expect(bundle.prompt).toContain("CUDA hazards");
  });

  it("omits CUDA review guidance for a non-CUDA feature", async () => {
    const root = await fixtureRoot("clawpatch-prompt-noncuda-review-");
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const tsFeature: FeatureRecord = {
      ...feature(),
      entrypoints: [],
      ownedFiles: [{ path: "src/index.ts", reason: "primary" }],
      contextFiles: [],
    };
    const bundle = await buildReviewPromptBundle(root, project(root), tsFeature, defaultConfig());

    expect(bundle.prompt).not.toContain("CUDA hazards");
  });

  it("omits CUDA review guidance in deslopify mode even for a CUDA feature", async () => {
    const root = await fixtureRoot("clawpatch-prompt-cuda-deslopify-");
    await writeFixture(root, "src/kernel.cu", "__global__ void k(void) {}\n");
    const cudaFeature: FeatureRecord = {
      ...feature(),
      entrypoints: [],
      ownedFiles: [{ path: "src/kernel.cu", reason: "kernel" }],
      contextFiles: [],
    };
    const bundle = await buildReviewPromptBundle(
      root,
      project(root),
      cudaFeature,
      defaultConfig(),
      "deslopify",
    );

    expect(bundle.prompt).not.toContain("CUDA hazards");
  });

  it("includes CUDA review guidance for a mixed feature whose entrypoint is C++ but owns a .cu file", async () => {
    const root = await fixtureRoot("clawpatch-prompt-cuda-mixed-");
    await writeFixture(root, "src/main.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/kernel.cu", "__global__ void k(void) {}\n");
    const mixedFeature: FeatureRecord = {
      ...feature(),
      entrypoints: [{ path: "src/main.cpp", symbol: "main", route: null, command: null }],
      ownedFiles: [
        { path: "src/main.cpp", reason: "host" },
        { path: "src/kernel.cu", reason: "kernel" },
      ],
      contextFiles: [],
    };
    const bundle = await buildReviewPromptBundle(
      root,
      project(root),
      mixedFeature,
      defaultConfig(),
    );

    expect(bundle.prompt).toContain("CUDA hazards");
  });

  it("includes CUDA guidance in the fix prompt for a CUDA feature", async () => {
    const root = await fixtureRoot("clawpatch-prompt-cuda-fix-");
    await writeFixture(root, "src/kernel.cu", "__global__ void k(void) {}\n");
    const cudaFeature: FeatureRecord = {
      ...feature(),
      entrypoints: [],
      ownedFiles: [{ path: "src/kernel.cu", reason: "kernel" }],
      contextFiles: [],
    };
    const prompt = await buildFixPrompt(
      root,
      finding("src/kernel.cu"),
      cudaFeature,
      defaultConfig(),
    );

    expect(prompt).toContain("CUDA hazards");
  });

  it("omits CUDA guidance in the fix prompt for a non-CUDA feature", async () => {
    const root = await fixtureRoot("clawpatch-prompt-noncuda-fix-");
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const tsFeature: FeatureRecord = {
      ...feature(),
      entrypoints: [],
      ownedFiles: [{ path: "src/index.ts", reason: "primary" }],
      contextFiles: [],
    };
    const prompt = await buildFixPrompt(root, finding("src/index.ts"), tsFeature, defaultConfig());

    expect(prompt).not.toContain("CUDA hazards");
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
