import { describe, expect, it, vi } from "vitest";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  fixCommand,
  cleanLocksCommand,
  ciCommand,
  doctorCommand,
  initCommand,
  makeContext,
  mapCommand,
  nextCommand,
  openPrCommand,
  reportCommand,
  revalidateCommand,
  reviewCommand,
  showCommand,
  statusCommand,
  triageCommand,
} from "./app.js";
import { main as cliMain, packageVersion, parseArgs } from "./cli.js";
import { defaultConfig, loadConfig } from "./config.js";
import { runCommand } from "./exec.js";
import { changedFilesSince, dirtyFiles } from "./git.js";
import { mapWithSource } from "./agent-mapper.js";
import { mapFeatures } from "./mapper.js";
import {
  claimFeature,
  releaseFeatureLock,
  readFeatures,
  readFinding,
  readFindings,
  readProject,
  readPatchAttempts,
  readRuns,
  statePaths,
  writeFeature,
  writeFinding,
  writePatchAttempt,
} from "./state.js";
import { buildFixPrompt, buildReviewPrompt } from "./prompt.js";
import type { Provider } from "./provider.js";
import { fixtureRoot, testOptions, writeFixture } from "./test-helpers.js";
import { findingRecordSchema } from "./types.js";
import type { FeatureRecord, PatchAttempt } from "./types.js";

const symlinkIt = process.platform === "win32" ? it.skip : it;
const posixFileModeIt = process.platform === "win32" ? it.skip : it;
const posixPathspecIt = process.platform === "win32" ? it.skip : it;

async function sinceFixture(prefix: string): Promise<string> {
  const root = await fixtureRoot(prefix);
  await writeFixture(
    root,
    "package.json",
    JSON.stringify({
      name: "since",
      bin: {
        one: "src/one.ts",
        two: "src/two.ts",
        three: "src/three.ts",
      },
      scripts: { test: "vitest run" },
    }),
  );
  await writeFixture(root, "src/one.ts", "export const one = 'TODO_BUG';\n");
  await writeFixture(root, "src/two.ts", "export const two = 'TODO_BUG';\n");
  await writeFixture(root, "src/three.ts", "export const three = 'TODO_BUG';\n");
  await writeFixture(root, "tests/one.test.ts", "expect('one').toBe('one');\n");
  await initGit(root);
  await commitAll(root, "base");
  await checkCommand(root, "git tag --no-sign base");
  return root;
}

function agentMapProvider(title: () => string): Provider {
  const feature = () => ({
    title: title(),
    summary: "Provider grouped custom agent files.",
    kind: "library" as const,
    confidence: "medium" as const,
    entrypoints: [{ path: "agent/worker.custom", symbol: null, route: null, command: null }],
    ownedFiles: [
      { path: "agent/worker.custom", reason: "worker" },
      { path: "agent/scheduler.custom", reason: "scheduler" },
    ],
    contextFiles: [],
    tests: [],
    tags: ["agent"],
    trustBoundaries: [],
    reason: "custom provider fixture",
  });
  return {
    name: "test-agent-map",
    async check() {
      return "test-agent-map";
    },
    async map() {
      return { features: [feature(), feature()], notes: [] };
    },
    async review() {
      throw new Error("unused");
    },
    async fix() {
      throw new Error("unused");
    },
    async revalidate() {
      throw new Error("unused");
    },
  };
}

async function initGit(root: string): Promise<void> {
  await checkCommand(root, "git init -q");
  await checkCommand(root, "git config user.email test@example.com");
  await checkCommand(root, "git config user.name Test");
  await checkCommand(root, "git config commit.gpgsign false");
  await checkCommand(root, "git config tag.gpgSign false");
}

async function commitAll(root: string, message: string): Promise<void> {
  await checkCommand(root, "git add package.json src tests");
  await checkCommand(root, `git -c commit.gpgsign=false commit -q -m "${message}"`);
}

async function checkCommand(root: string, command: string): Promise<void> {
  const result = await runCommand(command, root);
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

async function writeGhSuccessScript(root: string, url: string): Promise<string> {
  if (process.platform === "win32") {
    const path = "success-gh.cmd";
    await writeFixture(root, path, `@echo off\r\necho ${url}\r\n`);
    return join(root, path);
  }
  const path = "success-gh.sh";
  const fullPath = join(root, path);
  await writeFixture(root, path, `#!/bin/sh\necho ${url}\n`);
  await chmod(fullPath, 0o755);
  return fullPath;
}

async function writeGhFailureScript(root: string): Promise<string> {
  if (process.platform === "win32") {
    const path = "fail-gh.cmd";
    await writeFixture(root, path, "@echo off\r\nexit /b 42\r\n");
    return join(root, path);
  }
  const path = "fail-gh.sh";
  const fullPath = join(root, path);
  await writeFixture(root, path, "#!/bin/sh\nexit 42\n");
  await chmod(fullPath, 0o755);
  return fullPath;
}

async function runCli(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    await cliMain(argv);
    return { stdout, stderr };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function expectedFeatureIds(
  features: FeatureRecord[],
  changed: Set<string>,
  includeContext: boolean,
): string[] {
  return features
    .filter((feature) => ["pending", "error"].includes(feature.status))
    .filter((feature) => featureTouches(feature, changed, includeContext))
    .map((feature) => feature.featureId);
}

function featureTouches(
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

describe("workflow", () => {
  it("rejects unknown long flags", () => {
    expect(() => parseArgs(["fix", "--finding", "f", "--dryrun"])).toThrow("unknown arg");
  });

  it("rejects unknown commands and missing required flags before context setup", () => {
    expect(() => parseArgs(["nope"])).toThrow("unknown command: nope");
    expect(() => parseArgs(["constructor"])).toThrow("unknown command: constructor");
    expect(parseArgs(["revie", "--help"])).toMatchObject({
      command: "revie",
      help: true,
    });
    expect(() => parseArgs(["show"])).toThrow("missing --finding");
    expect(() => parseArgs(["triage", "--status", "fixed"])).toThrow("missing --finding");
    expect(() => parseArgs(["revalidate"])).toThrow("missing --finding or --all");
    expect(parseArgs(["revalidate", "--all"]).flags).toMatchObject({
      all: true,
    });
  });

  it("rejects value flags followed by another option token", () => {
    expect(() => parseArgs(["show", "--finding", "--json"])).toThrow("missing value for --finding");
    expect(() => parseArgs(["show", "--finding", "--bogus"])).toThrow(
      "missing value for --finding",
    );
    expect(() => parseArgs(["report", "-o", "--json"])).toThrow("missing value for -o");
    expect(() => parseArgs(["report", "-o", "-q"])).toThrow("missing value for -o");
  });

  it("prints package metadata version", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };

    expect(packageVersion()).toBe(pkg.version);
  });

  it("rejects unsupported command flags instead of ignoring them", () => {
    expect(() => parseArgs(["clean-locks", "--dry-run"])).toThrow(
      "unsupported flag for clean-locks: --dry-run",
    );
    expect(() => parseArgs(["--dry-run", "clean-locks"])).toThrow(
      "unsupported flag for clean-locks: --dry-run",
    );
    expect(parseArgs(["map", "--dry-run"]).flags).toMatchObject({
      dryRun: true,
    });
    expect(parseArgs(["map", "--source", "auto", "--provider", "mock"]).flags).toMatchObject({
      source: "auto",
      provider: "mock",
    });
    expect(parseArgs(["review", "--reasoning-effort", "xhigh", "--dry-run"]).flags).toMatchObject({
      dryRun: true,
      reasoningEffort: "xhigh",
    });
    expect(parseArgs(["review", "--skip-git-repo-check"]).flags).toMatchObject({
      skipGitRepoCheck: true,
    });
    expect(parseArgs(["ci", "--skip-git-repo-check"]).flags).toMatchObject({
      skipGitRepoCheck: true,
    });
    expect(parseArgs(["fix", "--finding", "f", "--dry-run"]).flags).toMatchObject({
      dryRun: true,
      finding: "f",
    });
    expect(
      parseArgs([
        "open-pr",
        "--patch",
        "pat_123",
        "--base",
        "main",
        "--branch",
        "clawpatch/pat_123",
        "--draft",
        "--dry-run",
      ]).flags,
    ).toMatchObject({
      patch: "pat_123",
      base: "main",
      branch: "clawpatch/pat_123",
      draft: true,
      dryRun: true,
    });
  });

  it("parses review jobs and report filters", () => {
    expect(
      parseArgs(["review", "--limit", "4", "--jobs", "3", "--project", "apps/web"]).flags,
    ).toMatchObject({
      limit: "4",
      jobs: "3",
      project: "apps/web",
    });
    expect(parseArgs(["review", "--since", "HEAD~5"]).flags).toMatchObject({
      since: "HEAD~5",
    });
    expect(parseArgs(["review", "--include-dirty"]).flags).toMatchObject({
      includeDirty: true,
    });
    expect(parseArgs(["review", "--mode", "deslopify"]).flags).toMatchObject({
      mode: "deslopify",
    });
    expect(() => parseArgs(["review", "--mode", "simplify"])).toThrow(
      "invalid --mode; expected default or deslopify",
    );
    expect(() => parseArgs(["review", "--mode", "slop"])).toThrow(
      "invalid --mode; expected default or deslopify",
    );
    expect(
      parseArgs([
        "ci",
        "--since",
        "origin/main",
        "--limit",
        "2",
        "--jobs",
        "1",
        "--output",
        "report.md",
      ]).flags,
    ).toMatchObject({
      since: "origin/main",
      limit: "2",
      jobs: "1",
      output: "report.md",
    });
    expect(parseArgs(["ci", "--include-dirty"]).flags).toMatchObject({
      includeDirty: true,
    });
    expect(parseArgs(["revalidate", "--since", "origin/main"]).flags).toMatchObject({
      since: "origin/main",
    });
    expect(parseArgs(["revalidate", "--include-dirty"]).flags).toMatchObject({
      includeDirty: true,
    });
    expect(
      parseArgs(["report", "--status", "open", "--severity", "high", "--project", "web"]).flags,
    ).toMatchObject({
      status: "open",
      severity: "high",
      project: "web",
    });
    expect(
      parseArgs(["triage", "--finding", "f", "--status", "wont-fix", "--note", "ok"]).flags,
    ).toMatchObject({
      finding: "f",
      status: "wont-fix",
      note: "ok",
    });
  });

  it("derives triage for legacy findings without triage fields", () => {
    const parsed = findingRecordSchema.parse({
      schemaVersion: 1,
      findingId: "fnd_legacy",
      featureId: "feat_legacy",
      title: "Missing test",
      category: "test-gap",
      severity: "medium",
      confidence: "high",
      evidence: [],
      reasoning: "legacy",
      reproduction: null,
      recommendation: "Add a test.",
      status: "open",
      signature: "sig_legacy",
      linkedPatchAttemptIds: [],
      createdByRunId: "run",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(parsed.triage).toBe("test-gap");
  });

  it("rejects nonexistent explicit roots before init", async () => {
    const root = join(await fixtureRoot("clawpatch-missing-root-parent-"), "missing");

    await expect(makeContext(testOptions(root))).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it("resolves relative explicit roots before provider commands use them", async () => {
    const root = await fixtureRoot("clawpatch-relative-root-parent-");
    await mkdir(join(root, "app"), { recursive: true });
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      const context = await makeContext(testOptions("app"));

      await expect(realpath(context.root)).resolves.toBe(await realpath(join(root, "app")));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("initializes, maps, reviews, and reports findings", async () => {
    const root = await fixtureRoot("clawpatch-flow-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "buggy-cli",
          bin: { buggy: "src/index.ts" },
          scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "tsconfig.json", "{}");
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const mapped = await mapCommand(context);
    const reviewed = await reviewCommand(context, { limit: "1" });
    const paths = statePaths(join(root, ".clawpatch"));
    const finding = (await readFindings(paths))[0];
    const reviewedFeature = (await readFeatures(paths)).find(
      (feature) => feature.featureId === finding?.featureId,
    );
    expect(finding).toBeDefined();
    await writeFinding(paths, {
      ...finding!,
      evidence: [{ ...finding!.evidence[0]!, startLine: 1, endLine: 1 }],
    });
    const status = await statusCommand(context);
    const report = await reportCommand(context, {});
    const jsonReport = await reportCommand(
      { ...context, options: { ...context.options, json: true } },
      { status: "open", severity: "medium" },
    );

    expect(mapped).toMatchObject({ new: expect.any(Number) });
    expect(reviewed).toMatchObject({ findings: 1, jobs: 1 });
    expect(status).toMatchObject({ openFindings: 1 });
    expect(report).toMatchObject({ findings: 1 });
    expect(report).toMatchObject({
      markdown: expect.stringContaining("src/index.ts:1"),
    });
    expect(report).toMatchObject({
      markdown: expect.stringContaining("test analysis:"),
    });
    expect(jsonReport).toMatchObject({
      findings: 1,
      total: 1,
      items: [
        {
          id: expect.stringMatching(/^fnd_/u),
          severity: "medium",
          status: "open",
          evidence: [{ path: "src/index.ts", startLine: 1 }],
          whyTestsDoNotAlreadyCoverThis: expect.any(String),
          suggestedRegressionTest: expect.any(String),
          minimumFixScope: expect.any(String),
        },
      ],
    });
    expect(reviewedFeature?.analysisHistory.at(-1)?.summary).toContain("prompt=");
    const aliased = jsonReport as {
      findings: number;
      total: number;
      items: unknown[];
      results: unknown[];
    };
    expect(aliased.total).toBe(aliased.findings);
    expect(aliased.total).toBe(aliased.items.length);
    expect(aliased.results).toBe(aliased.items);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("runs CI review flow and appends a GitHub step summary", async () => {
    const root = await fixtureRoot("clawpatch-ci-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "ci-flow",
        bin: { app: "src/index.ts" },
        scripts: { test: "vitest run" },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    const summaryPath = join(root, "summary.md");
    const reportPath = join(root, "review.md");
    const previousProvider = process.env["CLAWPATCH_PROVIDER"];
    const previousSummary = process.env["GITHUB_STEP_SUMMARY"];
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    process.env["GITHUB_STEP_SUMMARY"] = summaryPath;
    try {
      const context = await makeContext(testOptions(root));
      const result = await ciCommand(context, { limit: "1", jobs: "1", output: reportPath });
      const summary = await readFile(summaryPath, "utf8");
      const report = await readFile(reportPath, "utf8");

      expect(result).toMatchObject({
        initialized: true,
        mapped: expect.any(Number),
        reviewed: 1,
        findings: 1,
        report: reportPath,
        githubStepSummary: summaryPath,
      });
      expect(summary).toContain("## Clawpatch review");
      expect(summary).toContain("- findings: 1");
      expect(report).toContain("# clawpatch report");
    } finally {
      if (previousProvider === undefined) {
        delete process.env["CLAWPATCH_PROVIDER"];
      } else {
        process.env["CLAWPATCH_PROVIDER"] = previousProvider;
      }
      if (previousSummary === undefined) {
        delete process.env["GITHUB_STEP_SUMMARY"];
      } else {
        process.env["GITHUB_STEP_SUMMARY"] = previousSummary;
      }
    }
  });

  it("does not count stale report findings as CI review findings", async () => {
    const root = await fixtureRoot("clawpatch-ci-stale-findings-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "ci-stale", bin: { app: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await initGit(root);
    await checkCommand(root, "git add package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "initial"');
    const summaryPath = join(root, "summary.md");
    const previousProvider = process.env["CLAWPATCH_PROVIDER"];
    const previousSummary = process.env["GITHUB_STEP_SUMMARY"];
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    process.env["GITHUB_STEP_SUMMARY"] = summaryPath;
    try {
      const context = await makeContext(testOptions(root));
      await initCommand(context, {});
      await mapCommand(context);
      await reviewCommand(context, { limit: "1" });

      const result = await ciCommand(context, { since: "HEAD", limit: "10" });
      const summary = await readFile(summaryPath, "utf8");

      expect(result).toMatchObject({
        reviewed: 0,
        findings: 0,
        reportFindings: 1,
      });
      expect(summary).toContain("- findings: 0");
      expect(summary).toContain("- report findings: 1");
    } finally {
      if (previousProvider === undefined) {
        delete process.env["CLAWPATCH_PROVIDER"];
      } else {
        process.env["CLAWPATCH_PROVIDER"] = previousProvider;
      }
      if (previousSummary === undefined) {
        delete process.env["GITHUB_STEP_SUMMARY"];
      } else {
        process.env["GITHUB_STEP_SUMMARY"] = previousSummary;
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "reviews end-to-end when codex writes fenced JSON with trailing prose",
    async () => {
      const root = await fixtureRoot("clawpatch-codex-fenced-e2e-");
      await writeFixture(
        root,
        "package.json",
        JSON.stringify({
          name: "codex-fenced",
          bin: { app: "src/index.ts" },
          scripts: { test: "vitest run" },
        }),
      );
      await writeFixture(root, "src/index.ts", "export const value = 'ok';\n");
      const binDir = join(root, "bin");
      const codexShim = join(binDir, "codex");
      await writeFixture(
        root,
        "bin/codex",
        [
          "#!/usr/bin/env node",
          'const { writeFileSync } = require("node:fs");',
          "const args = process.argv.slice(2);",
          'if (args.includes("--version")) { console.log("codex fake 0.130.0"); process.exit(0); }',
          'const outputIndex = args.indexOf("--output-last-message");',
          "if (outputIndex === -1 || outputIndex + 1 >= args.length) {",
          '  console.error("missing --output-last-message");',
          "  process.exit(2);",
          "}",
          "const payload = {",
          "  findings: [],",
          '  inspected: { files: ["src/index.ts"], symbols: [], notes: ["fake codex"] },',
          "};",
          "writeFileSync(",
          "  args[outputIndex + 1],",
          '  ["```json", JSON.stringify(payload), "```", "Now I have a complete picture."].join("\\n"),',
          ");",
          "",
        ].join("\n"),
      );
      await chmod(codexShim, 0o755);
      const previousProvider = process.env["CLAWPATCH_PROVIDER"];
      const previousPath = process.env["PATH"];
      process.env["CLAWPATCH_PROVIDER"] = "codex";
      process.env["PATH"] = `${binDir}${delimiter}${previousPath ?? ""}`;
      try {
        const context = await makeContext(testOptions(root));

        await initCommand(context, {});
        await mapCommand(context);
        const reviewed = await reviewCommand(context, { limit: "1" });
        const paths = statePaths(join(root, ".clawpatch"));
        const [features, findings, runs] = await Promise.all([
          readFeatures(paths),
          readFindings(paths),
          readRuns(paths),
        ]);

        expect(reviewed).toMatchObject({ reviewed: 1, findings: 0 });
        expect(findings).toHaveLength(0);
        expect(runs.at(-1)).toMatchObject({ status: "completed", errors: [] });
        expect(features.some((feature) => feature.status === "reviewed")).toBe(true);
        expect(
          features.some((feature) =>
            feature.analysisHistory.some((entry) => entry.provider === "codex"),
          ),
        ).toBe(true);
      } finally {
        if (previousProvider === undefined) {
          delete process.env["CLAWPATCH_PROVIDER"];
        } else {
          process.env["CLAWPATCH_PROVIDER"] = previousProvider;
        }
        if (previousPath === undefined) {
          delete process.env["PATH"];
        } else {
          process.env["PATH"] = previousPath;
        }
      }
    },
  );

  it("selects review features whose owned files overlap the diff range", async () => {
    const root = await sinceFixture("clawpatch-since-owned-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "src/two.ts", "export const two = 'changed';\n");
    await commitAll(root, "change two");
    const paths = statePaths(join(root, ".clawpatch"));
    const features = await readFeatures(paths);
    const reviewed = await reviewCommand(context, {
      since: "base",
      limit: "20",
      dryRun: true,
    });

    expect(reviewed).toMatchObject({
      dryRun: true,
      featureIds: expectedFeatureIds(features, new Set(["src/two.ts"]), true),
    });
  });

  it("selects review features whose context files overlap the diff range", async () => {
    const root = await sinceFixture("clawpatch-since-context-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "tests/one.test.ts", "expect('changed').toBe('changed');\n");
    await commitAll(root, "change test");
    const paths = statePaths(join(root, ".clawpatch"));
    const features = await readFeatures(paths);
    const reviewed = await reviewCommand(context, {
      since: "base",
      limit: "20",
      dryRun: true,
    });
    const selectedIds = (reviewed as { featureIds: string[] }).featureIds;

    expect(selectedIds).toEqual(expectedFeatureIds(features, new Set(["tests/one.test.ts"]), true));
    expect(selectedIds.length).toBeGreaterThan(0);
    expect(
      selectedIds.every((id) =>
        features
          .find((feature) => feature.featureId === id)
          ?.contextFiles.some((file) => file.path === "tests/one.test.ts"),
      ),
    ).toBe(true);
  });

  it("returns cleanly when --since touches no review features", async () => {
    const root = await sinceFixture("clawpatch-since-empty-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = await reviewCommand(context, {
      since: "HEAD",
      dryRun: true,
    });

    expect(reviewed).toMatchObject({ next: "no features touched by diff" });
  });

  it("writes an empty tribunal ledger when --since touches no review features", async () => {
    const root = await sinceFixture("clawpatch-since-empty-tribunal-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const exportPath = join(root, "empty-tribunal.jsonl");
    const reviewed = await reviewCommand(context, {
      since: "HEAD",
      exportTribunalLedger: exportPath,
    });

    expect(reviewed).toMatchObject({
      exportTribunalLedger: exportPath,
      next: "no features touched by diff",
    });
    expect(await readFile(exportPath, "utf8")).toBe("");
  });

  it("does not write a tribunal ledger during no-op review dry-runs", async () => {
    const root = await sinceFixture("clawpatch-since-empty-tribunal-dry-run-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const exportPath = join(root, "dry-run-tribunal.jsonl");
    await writeFixture(root, "dry-run-tribunal.jsonl", "keep\n");
    const reviewed = await reviewCommand(context, {
      since: "HEAD",
      dryRun: true,
      exportTribunalLedger: exportPath,
    });

    expect(reviewed).toMatchObject({ next: "no features touched by diff" });
    expect(Object.hasOwn(reviewed as Record<string, unknown>, "exportTribunalLedger")).toBe(false);
    expect(await readFile(exportPath, "utf8")).toBe("keep\n");
  });

  it("rejects invalid --since refs before running git diff", async () => {
    const root = await sinceFixture("clawpatch-since-invalid-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);

    await expect(reviewCommand(context, { since: "bad ref with spaces" })).rejects.toMatchObject({
      code: "invalid-input",
      exitCode: 2,
    });
  });

  it("applies --since before --limit for review selection", async () => {
    const root = await sinceFixture("clawpatch-since-limit-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "src/two.ts", "export const two = 'changed';\n");
    await writeFixture(root, "src/three.ts", "export const three = 'changed';\n");
    await commitAll(root, "change two and three");
    const paths = statePaths(join(root, ".clawpatch"));
    const features = await readFeatures(paths);
    const reviewed = await reviewCommand(context, {
      since: "base",
      limit: "2",
      dryRun: true,
    });

    expect(reviewed).toMatchObject({
      dryRun: true,
      featureIds: expectedFeatureIds(features, new Set(["src/two.ts", "src/three.ts"]), true).slice(
        0,
        2,
      ),
    });
  });

  it("defaults review --since to all touched features when --limit is omitted", async () => {
    const root = await sinceFixture("clawpatch-since-default-limit-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "src/two.ts", "export const two = 'changed';\n");
    await writeFixture(root, "src/three.ts", "export const three = 'changed';\n");
    await commitAll(root, "change two and three");
    const paths = statePaths(join(root, ".clawpatch"));
    const features = await readFeatures(paths);
    const expected = expectedFeatureIds(features, new Set(["src/two.ts", "src/three.ts"]), true);
    const reviewed = await reviewCommand(context, {
      since: "base",
      dryRun: true,
    });

    expect(reviewed).toMatchObject({ dryRun: true, featureIds: expected });
    expect((reviewed as { featureIds: string[] }).featureIds.length).toBeGreaterThan(1);
  });

  it("selects review features whose files are dirty", async () => {
    const root = await sinceFixture("clawpatch-dirty-review-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "src/two.ts", "export const two = 'dirty';\n");
    const paths = statePaths(join(root, ".clawpatch"));
    const features = await readFeatures(paths);
    const reviewed = await reviewCommand(context, {
      includeDirty: true,
      limit: "20",
      dryRun: true,
    });

    expect(await dirtyFiles(root)).toContain("src/two.ts");
    expect(reviewed).toMatchObject({
      dryRun: true,
      featureIds: expectedFeatureIds(features, new Set(["src/two.ts"]), true),
    });
  });

  it("unions --since and --include-dirty review files", async () => {
    const root = await sinceFixture("clawpatch-since-dirty-union-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "src/two.ts", "export const two = 'changed';\n");
    await commitAll(root, "change two");
    await writeFixture(root, "src/three.ts", "export const three = 'dirty';\n");
    const paths = statePaths(join(root, ".clawpatch"));
    const features = await readFeatures(paths);
    const expected = expectedFeatureIds(features, new Set(["src/two.ts", "src/three.ts"]), true);
    const reviewed = await reviewCommand(context, {
      since: "base",
      includeDirty: true,
      dryRun: true,
    });

    expect(reviewed).toMatchObject({ dryRun: true, featureIds: expected });
    expect((reviewed as { featureIds: string[] }).featureIds.length).toBeGreaterThan(1);
  });

  it("runs review --include-dirty through the CLI entrypoint", async () => {
    const root = await sinceFixture("clawpatch-dirty-cli-");
    await runCli(["--root", root, "--json", "--quiet", "init"]);
    await runCli(["--root", root, "--json", "--quiet", "map"]);
    await writeFixture(root, "src/two.ts", "export const two = 'dirty';\n");
    const paths = statePaths(join(root, ".clawpatch"));
    const features = await readFeatures(paths);

    const reviewed = await runCli([
      "--root",
      root,
      "--json",
      "--quiet",
      "review",
      "--include-dirty",
      "--limit",
      "20",
      "--dry-run",
    ]);

    expect(JSON.parse(reviewed.stdout)).toMatchObject({
      dryRun: true,
      featureIds: expectedFeatureIds(features, new Set(["src/two.ts"]), true),
    });
    expect(reviewed.stderr).toBe("");
  });

  it("keeps explicit invalid review --since limits capped to one feature", async () => {
    const root = await sinceFixture("clawpatch-since-invalid-limit-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "src/two.ts", "export const two = 'changed';\n");
    await writeFixture(root, "src/three.ts", "export const three = 'changed';\n");
    await commitAll(root, "change two and three");
    const reviewed = await reviewCommand(context, {
      since: "base",
      limit: "0",
      dryRun: true,
    });

    expect(reviewed).toMatchObject({ dryRun: true, wouldReview: 1 });
    expect((reviewed as { featureIds: string[] }).featureIds).toHaveLength(1);
  });

  it("runs review --since through the CLI entrypoint", async () => {
    const root = await sinceFixture("clawpatch-since-cli-");
    await runCli(["--root", root, "--json", "--quiet", "init"]);
    await runCli(["--root", root, "--json", "--quiet", "map"]);
    await writeFixture(root, "src/two.ts", "export const two = 'changed';\n");
    await commitAll(root, "change two");
    const paths = statePaths(join(root, ".clawpatch"));
    const features = await readFeatures(paths);

    const reviewed = await runCli([
      "--root",
      root,
      "--json",
      "--quiet",
      "review",
      "--since",
      "base",
      "--limit",
      "20",
      "--dry-run",
    ]);

    expect(JSON.parse(reviewed.stdout)).toMatchObject({
      dryRun: true,
      featureIds: expectedFeatureIds(features, new Set(["src/two.ts"]), true),
    });
    expect(reviewed.stderr).toBe("");
  });

  it("keeps the full changed file list for large --since diffs", async () => {
    const root = await fixtureRoot("clawpatch-since-large-");
    const files = Array.from(
      { length: 220 },
      (_value, index) =>
        `src/file-${String(index + 1).padStart(3, "0")}-abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz.ts`,
    );
    const targetPath = files[109]!;
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "since-large",
        bin: { target: targetPath },
        scripts: { test: "vitest run" },
      }),
    );
    for (const file of files) {
      await writeFixture(root, file, "export const value = 'base';\n");
    }
    await writeFixture(root, "tests/target.test.ts", "expect('target').toBe('target');\n");
    await initGit(root);
    await commitAll(root, "base");
    await checkCommand(root, "git tag --no-sign base");
    for (const file of files) {
      await writeFixture(root, file, "export const value = 'changed';\n");
    }
    await commitAll(root, "change many files");
    const changed = await changedFilesSince(root, "base");

    const context = await makeContext(testOptions(root));
    await initCommand(context, {});
    await mapCommand(context);
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const targetFeature = features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === targetPath),
    );
    const reviewed = (await reviewCommand(context, {
      since: "base",
      limit: "250",
      dryRun: true,
    })) as { featureIds: string[] };

    expect(changed.size).toBe(files.length);
    expect(changed).toContain(targetPath);
    expect(targetFeature).toBeDefined();
    expect(reviewed.featureIds).toContain(targetFeature!.featureId);
  });

  it("matches --since paths relative to an explicit subdirectory root", async () => {
    const repoRoot = await fixtureRoot("clawpatch-since-subdir-repo-");
    const root = join(repoRoot, "packages", "app");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "subdir", bin: { app: "src/app.ts" } }),
    );
    await writeFixture(root, "src/app.ts", "export const value = 'base';\n");
    await initGit(repoRoot);
    await checkCommand(repoRoot, "git add packages");
    await checkCommand(repoRoot, 'git -c commit.gpgsign=false commit -q -m "base"');
    await checkCommand(repoRoot, "git tag --no-sign base");
    const context = await makeContext(testOptions(root));
    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "src/app.ts", "export const value = 'changed';\n");
    await checkCommand(repoRoot, "git add packages/app/src/app.ts");
    await checkCommand(repoRoot, 'git -c commit.gpgsign=false commit -q -m "change app"');
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const targetFeature = features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "src/app.ts"),
    );
    const reviewed = (await reviewCommand(context, {
      since: "base",
      limit: "20",
      dryRun: true,
    })) as { featureIds: string[] };

    expect(targetFeature).toBeDefined();
    expect(reviewed.featureIds).toContain(targetFeature!.featureId);
  });

  it("matches dirty paths relative to an explicit subdirectory root", async () => {
    const repoRoot = await fixtureRoot("clawpatch-dirty-subdir-repo-");
    const root = join(repoRoot, "packages", "app");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "subdir", bin: { app: "src/app.ts" } }),
    );
    await writeFixture(root, "src/app.ts", "export const value = 'base';\n");
    await writeFixture(repoRoot, "packages/other/src/other.ts", "export const other = 'base';\n");
    await initGit(repoRoot);
    await checkCommand(repoRoot, "git add packages");
    await checkCommand(repoRoot, 'git -c commit.gpgsign=false commit -q -m "base"');
    const context = await makeContext(testOptions(root));
    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "src/app.ts", "export const value = 'dirty';\n");
    await writeFixture(repoRoot, "packages/other/src/other.ts", "export const other = 'dirty';\n");
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const targetFeature = features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "src/app.ts"),
    );
    const reviewed = (await reviewCommand(context, {
      includeDirty: true,
      limit: "20",
      dryRun: true,
    })) as { featureIds: string[] };

    const dirty = await dirtyFiles(root);
    expect(dirty).toContain("src/app.ts");
    expect(
      [...dirty].some((path) => path.startsWith("../") || path.includes("packages/other")),
    ).toBe(false);
    expect(targetFeature).toBeDefined();
    expect(reviewed.featureIds).toContain(targetFeature!.featureId);
  });

  it("revalidates only findings whose feature owned files overlap --since", async () => {
    const root = await sinceFixture("clawpatch-since-revalidate-");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { limit: "20", jobs: "2" });
    await writeFixture(root, "src/two.ts", "export const two = 'changed';\n");
    await commitAll(root, "change two");
    const paths = statePaths(join(root, ".clawpatch"));
    const [features, findings] = await Promise.all([readFeatures(paths), readFindings(paths)]);
    const touchedFeatureIds = new Set(
      features
        .filter((feature) => featureTouches(feature, new Set(["src/two.ts"]), false))
        .map((feature) => feature.featureId),
    );
    const expected = findings.filter((finding) => touchedFeatureIds.has(finding.featureId));
    const result = await revalidateCommand(context, { since: "base" });

    expect(result).toMatchObject({ revalidated: expected.length });
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("revalidates findings whose feature owned files are dirty", async () => {
    const root = await sinceFixture("clawpatch-dirty-revalidate-");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    try {
      await initCommand(context, {});
      await mapCommand(context);
      await reviewCommand(context, { limit: "20", jobs: "2" });
      await writeFixture(root, "src/two.ts", "export const two = 'dirty';\n");
      const paths = statePaths(join(root, ".clawpatch"));
      const [features, findings] = await Promise.all([readFeatures(paths), readFindings(paths)]);
      const touchedFeatureIds = new Set(
        features
          .filter((feature) => featureTouches(feature, new Set(["src/two.ts"]), false))
          .map((feature) => feature.featureId),
      );
      const expected = findings.filter((finding) => touchedFeatureIds.has(finding.featureId));
      const result = await revalidateCommand(context, { includeDirty: true });

      expect(result).toMatchObject({ revalidated: expected.length });
    } finally {
      delete process.env["CLAWPATCH_PROVIDER"];
    }
  });

  it("shows, prioritizes, and triages findings with history", async () => {
    const root = await fixtureRoot("clawpatch-finding-lifecycle-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "life",
        bin: { life: "src/index.ts" },
        scripts: { test: "vitest run" },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { limit: "1" });
    const paths = statePaths(join(root, ".clawpatch"));
    const finding = (await readFindings(paths))[0];
    expect(finding).toBeDefined();

    const next = await nextCommand(context, {});
    const shown = await showCommand(context, { finding: finding!.findingId });
    const report = await reportCommand(context, { status: "open" });
    const triaged = await triageCommand(context, {
      finding: finding!.findingId,
      status: "false-positive",
      note: "tests cover intended contract",
    });
    const updated = await readFinding(paths, finding!.findingId);

    expect(next).toMatchObject({ finding: finding!.findingId });
    expect(shown).toMatchObject({
      markdown: expect.stringContaining(`next: clawpatch triage --finding ${finding!.findingId}`),
    });
    expect(report).toMatchObject({
      markdown: expect.stringContaining(`next: clawpatch show --finding ${finding!.findingId}`),
    });
    expect(triaged).toMatchObject({ status: "false-positive" });
    expect(updated?.status).toBe("false-positive");
    expect(updated?.history.at(-1)).toMatchObject({
      kind: "triage",
      status: "false-positive",
      note: "tests cover intended contract",
    });
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("revalidates filtered findings in bulk and records history", async () => {
    const root = await fixtureRoot("clawpatch-revalidate-all-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "reval",
        bin: {
          fixed: "src/fixed.ts",
          open: "src/open.ts",
          falsey: "src/falsey.ts",
          uncertain: "src/uncertain.ts",
        },
      }),
    );
    await writeFixture(root, "src/fixed.ts", "export const fixed = 'TODO_BUG';\n");
    await writeFixture(root, "src/open.ts", "export const open = 'TODO_BUG';\n");
    await writeFixture(root, "src/falsey.ts", "export const falsey = 'TODO_BUG';\n");
    await writeFixture(root, "src/uncertain.ts", "export const uncertain = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { limit: "4", jobs: "2" });
    const paths = statePaths(join(root, ".clawpatch"));
    const findings = await readFindings(paths);
    expect(findings).toHaveLength(4);
    const markers = [
      "REVALIDATE_FIXED",
      "REVALIDATE_OPEN",
      "REVALIDATE_FALSE_POSITIVE",
      "REVALIDATE_UNCERTAIN",
    ];
    for (const [index, finding] of findings.entries()) {
      await writeFinding(paths, {
        ...finding,
        reasoning: markers[index] ?? "",
      });
    }

    let progress = "";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      progress += String(chunk);
      return true;
    });
    const result = await revalidateCommand(context, {
      all: true,
      status: "open",
      limit: "4",
    });
    stderr.mockRestore();
    const updated = await readFindings(paths);
    const features = await readFeatures(paths);

    expect(result).toMatchObject({
      revalidated: 4,
      fixed: 1,
      open: 1,
      falsePositive: 1,
      uncertain: 1,
    });
    expect(updated.map((finding) => finding.status).toSorted()).toEqual([
      "false-positive",
      "fixed",
      "open",
      "uncertain",
    ]);
    expect(updated.every((finding) => finding.history.at(-1)?.kind === "revalidate")).toBe(true);
    expect(progress).toContain("clawpatch revalidate start");
    expect(progress).toContain("clawpatch revalidate finding-start");
    expect(progress).toContain("clawpatch revalidate finding-done");
    expect(progress).toContain("clawpatch revalidate done");
    const uncertain = updated.find((finding) => finding.status === "uncertain");
    const uncertainFeature = features.find((feature) => feature.featureId === uncertain?.featureId);
    expect(uncertainFeature?.status).toBe("needs-fix");
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("preserves selected finding ids when revalidation fails", async () => {
    const root = await fixtureRoot("clawpatch-revalidate-fail-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "reval-fail", bin: { fail: "src/fail.ts" } }),
    );
    await writeFixture(root, "src/fail.ts", "export const fail = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { limit: "1" });
    const paths = statePaths(join(root, ".clawpatch"));
    const finding = (await readFindings(paths))[0];
    expect(finding).toBeDefined();

    await expect(
      revalidateCommand(context, {
        finding: finding!.findingId,
        provider: "mock-fail",
      }),
    ).rejects.toThrow("mock revalidate failure");
    const runs = await readRuns(paths);
    const failed = runs.find((run) => run.command === "revalidate");

    expect(failed).toMatchObject({
      status: "failed",
      findingIds: [finding!.findingId],
    });
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("reviews features concurrently without corrupting findings or locks", async () => {
    const root = await fixtureRoot("clawpatch-parallel-review-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "parallel",
        bin: { one: "src/one.ts", two: "src/two.ts" },
      }),
    );
    await writeFixture(root, "src/one.ts", "export const one = 'TODO_BUG';\n");
    await writeFixture(root, "src/two.ts", "export const two = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = await reviewCommand(context, { limit: "2", jobs: "2" });
    const paths = statePaths(join(root, ".clawpatch"));
    const [features, findings] = await Promise.all([readFeatures(paths), readFindings(paths)]);

    expect(reviewed).toMatchObject({ reviewed: 2, findings: 2, jobs: 2 });
    expect(findings).toHaveLength(2);
    expect(features.every((feature) => feature.lock === null)).toBe(true);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("claims feature locks atomically", async () => {
    const root = await fixtureRoot("clawpatch-atomic-lock-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "atomic-lock", bin: { atomic: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));

    await initCommand(context, {});
    await mapCommand(context);
    const feature = (await readFeatures(paths)).find((candidate) =>
      candidate.title.includes("CLI command"),
    );
    expect(feature).toBeDefined();

    const first = {
      lockedByRunId: "run-one",
      lockedAt: new Date().toISOString(),
      hostname: "test",
      pid: 1,
    };
    const second = {
      lockedByRunId: "run-two",
      lockedAt: new Date().toISOString(),
      hostname: "test",
      pid: 2,
    };
    const results = await Promise.allSettled([
      claimFeature(paths, feature!.featureId, first),
      claimFeature(paths, feature!.featureId, second),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "lock-conflict" },
    });
    expect(await readdir(paths.locks)).toEqual([`${feature!.featureId}.json`]);

    await releaseFeatureLock(paths, feature!.featureId);
    expect(await readdir(paths.locks)).toEqual([]);
  });

  it("cleans up lock files when claim lock payload writes fail", async () => {
    const root = await fixtureRoot("clawpatch-lock-write-fail-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "lock-write-fail",
        bin: { lock: "src/index.ts" },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));

    await initCommand(context, {});
    await mapCommand(context);
    const feature = (await readFeatures(paths)).find((candidate) =>
      candidate.title.includes("CLI command"),
    );
    expect(feature).toBeDefined();
    const probe = await open(join(paths.locks, "probe.json"), "w");
    const writeFileSpy = vi
      .spyOn(Object.getPrototypeOf(probe) as { writeFile: typeof probe.writeFile }, "writeFile")
      .mockRejectedValueOnce(new Error("simulated lock write failure"));
    await probe.close();
    await unlink(join(paths.locks, "probe.json"));

    await expect(
      claimFeature(paths, feature!.featureId, {
        lockedByRunId: "run",
        lockedAt: new Date().toISOString(),
        hostname: "test",
        pid: 1,
      }),
    ).rejects.toThrow("simulated lock write failure");
    expect(await readdir(paths.locks)).toEqual([]);

    writeFileSpy.mockRestore();
  });

  it("does not claim a stale feature after another run finishes it", async () => {
    const root = await fixtureRoot("clawpatch-stale-lock-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "stale-lock", bin: { stale: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));

    await initCommand(context, {});
    await mapCommand(context);
    const feature = (await readFeatures(paths)).find((candidate) =>
      candidate.title.includes("CLI command"),
    );
    expect(feature).toBeDefined();
    await writeFeature(paths, {
      ...feature!,
      status: "reviewed",
      lock: null,
      updatedAt: new Date().toISOString(),
    });

    await expect(
      claimFeature(paths, feature!.featureId, {
        lockedByRunId: "run",
        lockedAt: new Date().toISOString(),
        hostname: "test",
        pid: 1,
      }),
    ).rejects.toMatchObject({ code: "lock-conflict" });
    expect(await readdir(paths.locks)).toEqual([]);
  });

  it("does not consume features on dry-run review", async () => {
    const root = await fixtureRoot("clawpatch-dry-run-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "dry-run-cli", bin: { dry: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { dryRun: true });
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(features[0]?.status).toBe("pending");
  });

  it("filters review dry-runs by project name or root", async () => {
    const root = await fixtureRoot("clawpatch-project-filter-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/*"] }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify({ name: "web", dependencies: { next: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/project.json",
      JSON.stringify({ name: "web", targets: { test: {} } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/src/app/dashboard/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(
      root,
      "apps/admin/package.json",
      JSON.stringify({ name: "admin", dependencies: { next: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/admin/project.json",
      JSON.stringify({ name: "admin", targets: { test: {} } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/admin/src/app/dashboard/page.tsx",
      "export default function Page() { return null; }\n",
    );
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const byRoot = (await reviewCommand(context, {
      dryRun: true,
      project: "apps/web",
      limit: "20",
    })) as { featureIds: string[]; wouldReview: number };
    const byName = (await reviewCommand(context, {
      dryRun: true,
      project: "web",
      limit: "20",
    })) as { featureIds: string[]; wouldReview: number };
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const titleById = new Map(features.map((feature) => [feature.featureId, feature.title]));

    expect(byRoot.wouldReview).toBeGreaterThan(0);
    expect(byRoot.featureIds).toEqual(byName.featureIds);
    expect(byRoot.featureIds.map((id) => titleById.get(id))).toEqual(
      expect.arrayContaining(["Node package web", "web route /dashboard"]),
    );
    expect(byRoot.featureIds.map((id) => titleById.get(id))).not.toContain("Node package admin");
    expect(byRoot.featureIds.map((id) => titleById.get(id))).not.toContain(
      "admin route /dashboard",
    );
  });

  it("does not mutate features on dry-run map", async () => {
    const root = await fixtureRoot("clawpatch-map-dry-run-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "map-dry-run-cli", bin: { dry: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "package.json", JSON.stringify({ name: "map-dry-run-cli" }));
    const preview = await mapCommand(context, { dryRun: true });
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(preview).toMatchObject({ dryRun: true, stale: 1 });
    expect(features.some((feature) => feature.status === "skipped")).toBe(false);
  });

  it("emits map progress to stderr while preserving JSON stdout", async () => {
    const root = await fixtureRoot("clawpatch-map-progress-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "map-progress"\nversion = "0.1.0"\n');
    await writeFixture(root, "src/lib.rs", "pub fn run() {}\n");

    await runCli(["--root", root, "--json", "--quiet", "init"]);
    const mapped = await runCli(["--root", root, "--json", "map"]);

    expect(JSON.parse(mapped.stdout)).toMatchObject({
      features: expect.any(Number),
    });
    expect(mapped.stderr).toContain("clawpatch map start");
    expect(mapped.stderr).toContain("clawpatch map mapper-start mapper=rust");
    expect(mapped.stderr).toContain("clawpatch map mapper-done mapper=rust");
    expect(mapped.stderr).toContain("clawpatch map done");
  });

  it("suppresses map progress when quiet", async () => {
    const root = await fixtureRoot("clawpatch-map-progress-quiet-");
    await writeFixture(
      root,
      "Cargo.toml",
      '[package]\nname = "map-progress-quiet"\nversion = "0.1.0"\n',
    );
    await writeFixture(root, "src/lib.rs", "pub fn run() {}\n");

    await runCli(["--root", root, "--json", "--quiet", "init"]);
    const mapped = await runCli(["--root", root, "--json", "--quiet", "map"]);

    expect(JSON.parse(mapped.stdout)).toMatchObject({
      features: expect.any(Number),
    });
    expect(mapped.stderr).toBe("");
  });

  it("can use the configured provider as an agent mapper source", async () => {
    const root = await fixtureRoot("clawpatch-agent-map-");
    await writeFixture(root, "agent/worker.custom", "worker source\n");
    await writeFixture(root, "agent/scheduler.custom", "scheduler source\n");
    await writeFixture(root, "agent/worker.test.custom", "worker test\n");
    await writeFixture(root, "dist/agent/generated.custom", "generated source\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const mapped = await mapCommand(context, {
      source: "auto",
      provider: "mock",
    });
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const agentFeature = features.find((feature) => feature.source === "agent-mapper");

    expect(mapped).toMatchObject({
      source: "auto",
      usedAgent: true,
      reason: "heuristic mapper produced no features",
    });
    expect(agentFeature?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "agent/scheduler.custom",
      "agent/worker.custom",
    ]);
    expect(agentFeature?.ownedFiles.map((file) => file.path)).not.toContain(
      "dist/agent/generated.custom",
    );
    expect(agentFeature?.tests).toEqual([{ path: "agent/worker.test.custom", command: null }]);
  });

  it("builds agent mapper inventory from git-visible files and config filters", async () => {
    const root = await fixtureRoot("clawpatch-agent-map-git-inventory-");
    await writeFixture(
      root,
      "clawpatch.config.json",
      JSON.stringify({
        ...defaultConfig(),
        include: ["**/*"],
        exclude: ["ignored/**", "**/generated/**"],
      }),
    );
    await writeFixture(root, ".gitignore", "gitignored/\n");
    await writeFixture(root, "agent/worker.custom", "worker source\n");
    await writeFixture(root, "agent/worker.test.custom", "worker test\n");
    await writeFixture(root, "agent/deleted.custom", "deleted source\n");
    await writeFixture(root, "ignored/agent/by-config.custom", "config excluded\n");
    await writeFixture(root, "packages/app/generated/agent/by-glob.custom", "glob excluded\n");
    await writeFixture(root, "gitignored/agent/by-git.custom", "git ignored\n");
    await writeFixture(root, ".claude/worktrees/child/agent/ghost.custom", "nested worktree\n");
    await initGit(root);
    await checkCommand(root, "git add agent/deleted.custom");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "track deleted file"');
    await unlink(join(root, "agent/deleted.custom"));
    await checkCommand(root, "git init -q .claude/worktrees/child");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context, {
      source: "agent",
      provider: "mock",
    });
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const agentFeature = features.find((feature) => feature.source === "agent-mapper");

    expect(agentFeature?.ownedFiles.map((file) => file.path)).toEqual(["agent/worker.custom"]);
    expect(agentFeature?.tests).toEqual([{ path: "agent/worker.test.custom", command: null }]);
    expect(agentFeature?.ownedFiles.map((file) => file.path)).not.toContain(
      "ignored/agent/by-config.custom",
    );
    expect(agentFeature?.ownedFiles.map((file) => file.path)).not.toContain(
      "packages/app/generated/agent/by-glob.custom",
    );
    expect(agentFeature?.ownedFiles.map((file) => file.path)).not.toContain("agent/deleted.custom");
    expect(agentFeature?.ownedFiles.map((file) => file.path)).not.toContain(
      "gitignored/agent/by-git.custom",
    );
    expect(agentFeature?.ownedFiles.map((file) => file.path)).not.toContain(
      ".claude/worktrees/child/agent/ghost.custom",
    );
  });

  it("does not invoke agent mapping for meaningful Elixir heuristic coverage", async () => {
    const root = await fixtureRoot("clawpatch-elixir-auto-map-");
    await writeFixture(
      root,
      "mix.exs",
      'defmodule SampleApp.MixProject do\n  use Mix.Project\n  def project, do: [app: :sample_app, version: "0.1.0"]\nend\n',
    );
    await writeFixture(
      root,
      "lib/sample_app/accounts.ex",
      "defmodule SampleApp.Accounts do\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app/accounts/user.ex",
      "defmodule SampleApp.Accounts.User do\nend\n",
    );
    await writeFixture(
      root,
      "test/sample_app/accounts_test.exs",
      "defmodule SampleApp.AccountsTest do\nend\n",
    );
    for (let index = 1; index <= 20; index += 1) {
      await writeFixture(root, `deps/noise/lib/noise_${index}.ex`, "defmodule Noise do\nend\n");
    }
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const mapped = await mapCommand(context, {
      source: "auto",
      provider: "mock",
    });
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(mapped).toMatchObject({
      source: "auto",
      usedAgent: false,
      reason: "heuristic map is meaningful",
    });
    expect(features.map((feature) => feature.title)).toContain("Elixir context accounts");
    expect(features.some((feature) => feature.source === "agent-mapper")).toBe(false);
  });

  it("does not invoke agent mapping for dependency-only C source gaps", async () => {
    const root = await fixtureRoot("clawpatch-c-deps-auto-map-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/main.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    for (let index = 1; index <= 20; index += 1) {
      await writeFixture(root, `deps/native/noise_${index}.c`, "int noise(void) { return 0; }\n");
    }
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const mapped = await mapCommand(context, {
      source: "auto",
      provider: "mock",
    });
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(mapped).toMatchObject({
      source: "auto",
      usedAgent: false,
      reason: "heuristic map is meaningful",
    });
    expect(features.map((feature) => feature.title)).toContain("CMake binary app");
    expect(features.some((feature) => feature.source === "agent-mapper")).toBe(false);
  });

  it("does not accept agent mapped C dependency paths when heuristics are empty", async () => {
    const root = await fixtureRoot("clawpatch-c-deps-agent-map-");
    await writeFixture(root, "CMakeLists.txt", "project(unsupported)\n");
    await writeFixture(root, "deps/agent/worker.custom", "dependency agent source\n");
    await writeFixture(root, "deps/native/noise.c", "int noise(void) { return 0; }\n");
    await initGit(root);
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});

    await expect(mapCommand(context, { source: "agent", provider: "mock" })).rejects.toThrow(
      "agent mapper returned no valid features",
    );
  });

  it("includes F# and Visual Basic sources in agent mapper inventory", async () => {
    const root = await fixtureRoot("clawpatch-agent-map-dotnet-inventory-");
    await writeFixture(root, "src/FsLib/FsLib.fsproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/FsLib/Library.fs", 'module Library\nlet hello = "world"\n');
    await writeFixture(root, "src/FsLib/Signature.fsi", "module Library\nval hello: string\n");
    await writeFixture(root, "src/VbApp/VbApp.vbproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/VbApp/Program.vb", "Module Program\nEnd Module\n");
    const context = await makeContext(testOptions(root));
    let prompt = "";
    const provider: Provider = {
      name: "capture-agent-map",
      async check() {
        return "capture-agent-map";
      },
      async map(_root, nextPrompt) {
        prompt = nextPrompt;
        return {
          features: [
            {
              title: "F# library",
              summary: "Provider grouped F# source.",
              kind: "library",
              confidence: "medium",
              entrypoints: [
                { path: "src/FsLib/Library.fs", symbol: null, route: null, command: null },
              ],
              ownedFiles: [{ path: "src/FsLib/Library.fs", reason: "F# source" }],
              contextFiles: [],
              tests: [],
              tags: ["dotnet"],
              trustBoundaries: [],
              reason: "inventory fixture",
            },
          ],
          notes: [],
        };
      },
      async review() {
        throw new Error("unused");
      },
      async fix() {
        throw new Error("unused");
      },
      async revalidate() {
        throw new Error("unused");
      },
    };

    await initCommand(context, {});
    const paths = statePaths(join(root, ".clawpatch"));
    const project = await readProject(paths);
    if (project === null) {
      throw new Error("missing project");
    }
    const heuristic = await mapFeatures(root, project, []);
    await mapWithSource(root, project, [], heuristic, {
      source: "agent",
      provider,
      providerOptions: { model: null, reasoningEffort: null, skipGitRepoCheck: false },
    });

    expect(prompt).toContain('"src/FsLib/Library.fs"');
    expect(prompt).toContain('"src/FsLib/Signature.fsi"');
    expect(prompt).toContain('"src/VbApp/Program.vb"');
  });

  it("fails forced agent mapping when the provider returns no valid features", async () => {
    const root = await fixtureRoot("clawpatch-empty-agent-map-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "fallback-cli",
        bin: { fallback: "src/index.ts" },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await expect(mapCommand(context, { source: "agent", provider: "mock" })).rejects.toThrow(
      "agent mapper returned no valid features",
    );
  });

  it("keeps agent feature ids stable across title changes and drops duplicates", async () => {
    const root = await fixtureRoot("clawpatch-agent-map-stable-");
    await writeFixture(root, "agent/worker.custom", "worker source\n");
    await writeFixture(root, "agent/scheduler.custom", "scheduler source\n");
    const context = await makeContext(testOptions(root));
    await initCommand(context, {});
    const paths = statePaths(join(root, ".clawpatch"));
    const project = await readProject(paths);
    if (project === null) {
      throw new Error("missing project");
    }
    const heuristic = await mapFeatures(root, project, []);
    let title = "Agent worker group";
    const provider = agentMapProvider(() => title);

    const first = await mapWithSource(root, project, [], heuristic, {
      source: "agent",
      provider,
      providerOptions: {
        model: null,
        reasoningEffort: null,
        skipGitRepoCheck: false,
      },
    });
    title = "Background worker package";
    const second = await mapWithSource(root, project, first.features, heuristic, {
      source: "agent",
      provider,
      providerOptions: {
        model: null,
        reasoningEffort: null,
        skipGitRepoCheck: false,
      },
    });

    expect(first.features).toHaveLength(1);
    expect(second.features).toHaveLength(1);
    expect(second.features[0]?.featureId).toBe(first.features[0]?.featureId);
    expect(second.stale).toBe(0);
  });

  it("augments deterministic features when forced agent mapping returns partial coverage", async () => {
    const root = await fixtureRoot("clawpatch-agent-map-merge-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "merge-cli", bin: { merge: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    await writeFixture(root, "agent/worker.custom", "worker source\n");
    await writeFixture(root, "agent/scheduler.custom", "scheduler source\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const mapped = await mapCommand(context, {
      source: "agent",
      provider: "mock",
    });
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(mapped).toMatchObject({
      source: "agent",
      usedAgent: true,
      stale: 0,
    });
    expect(features.some((feature) => feature.source === "package-json-bin")).toBe(true);
    expect(features.some((feature) => feature.source === "agent-mapper")).toBe(true);
    expect(features.some((feature) => feature.status === "skipped")).toBe(false);
  });

  it("rejects invalid map source values", async () => {
    const root = await fixtureRoot("clawpatch-agent-map-bad-source-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await expect(mapCommand(context, { source: "magic", provider: "mock" })).rejects.toThrow(
      "invalid --source",
    );
  });

  symlinkIt("does not recurse through symlinked mapper directories", async () => {
    const root = await fixtureRoot("clawpatch-map-symlink-root-");
    const external = await fixtureRoot("clawpatch-map-symlink-external-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "map-symlink" }));
    await writeFixture(external, "page.tsx", "export default function Page() { return null; }\n");
    await symlink(external, join(root, "app"), "dir");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(features.some((feature) => feature.source === "next-app-route")).toBe(false);
  });

  it("seeds config commands from detected package scripts and package manager", async () => {
    const root = await fixtureRoot("clawpatch-config-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "npm-cli",
        scripts: { typecheck: "tsc --noEmit", test: "node --test" },
      }),
    );
    await writeFixture(root, "package-lock.json", "{}");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const config = JSON.parse(await readFile(join(root, ".clawpatch/config.json"), "utf8")) as {
      commands: { typecheck: string; test: string };
    };

    expect(config.commands.typecheck).toBe("npm run typecheck");
    expect(config.commands.test).toBe("npm run test");
  });

  it("honors CLAWPATCH_STATE_DIR during init", async () => {
    const root = await fixtureRoot("clawpatch-env-state-root-");
    const stateDir = await fixtureRoot("clawpatch-env-state-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "env-state" }));
    process.env["CLAWPATCH_STATE_DIR"] = stateDir;
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const project = await readProject(statePaths(stateDir));

    expect(project?.name).toBe("env-state");
    await expect(access(join(root, ".clawpatch"))).rejects.toThrow();
    delete process.env["CLAWPATCH_STATE_DIR"];
  });

  it("loads and reports Codex reasoning effort overrides", async () => {
    const root = await fixtureRoot("clawpatch-reasoning-effort-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "reasoning-effort" }));
    const previousProvider = process.env["CLAWPATCH_PROVIDER"];
    const previousReasoning = process.env["CLAWPATCH_REASONING_EFFORT"];
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    process.env["CLAWPATCH_REASONING_EFFORT"] = "xhigh";
    try {
      const context = await makeContext(testOptions(root));

      await initCommand(context, {});
      const config = await loadConfig(root, testOptions(root));
      const doctor = await doctorCommand(context, {});

      expect(config.provider.reasoningEffort).toBe("xhigh");
      expect(doctor).toMatchObject({
        provider: "mock",
        reasoningEffort: "xhigh",
      });
    } finally {
      if (previousProvider === undefined) {
        delete process.env["CLAWPATCH_PROVIDER"];
      } else {
        process.env["CLAWPATCH_PROVIDER"] = previousProvider;
      }
      if (previousReasoning === undefined) {
        delete process.env["CLAWPATCH_REASONING_EFFORT"];
      } else {
        process.env["CLAWPATCH_REASONING_EFFORT"] = previousReasoning;
      }
    }
  });

  it("allows fix dry-run when only the default state dir is dirty", async () => {
    const root = await fixtureRoot("clawpatch-state-dirty-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const fixed = await fixCommand(context, { finding, dryRun: true });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(fixed).toMatchObject({ dryRun: true });
    expect(patches).toEqual([]);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("retires stale features when seeds disappear", async () => {
    const root = await fixtureRoot("clawpatch-stale-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "stale-cli", bin: { stale: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await unlink(join(root, "src/index.ts"));
    await writeFixture(root, "package.json", JSON.stringify({ name: "stale-cli" }));
    await mapCommand(context);
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(features.some((feature) => feature.status === "skipped")).toBe(true);
  });

  it("counts stale features by missing ids", async () => {
    const root = await fixtureRoot("clawpatch-stale-count-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "stale-count", bin: { old: "src/old.ts" } }),
    );
    await writeFixture(root, "src/old.ts", "export const oldValue = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "stale-count", bin: { next: "src/next.ts" } }),
    );
    await writeFixture(root, "src/next.ts", "export const nextValue = 1;\n");
    const mapped = await mapCommand(context);

    expect(mapped).toMatchObject({ stale: 1 });
  });

  it("requeues restored skipped features", async () => {
    const root = await fixtureRoot("clawpatch-restore-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "restore-cli", bin: { restore: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await unlink(join(root, "src/index.ts"));
    await writeFixture(root, "package.json", JSON.stringify({ name: "restore-cli" }));
    await mapCommand(context);
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "restore-cli", bin: { restore: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    await mapCommand(context);
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const restored = features.find((feature) => feature.title === "CLI command restore");

    expect(restored?.status).toBe("pending");
  });

  it("releases feature locks on provider review failure", async () => {
    const root = await fixtureRoot("clawpatch-lock-fail-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "lock-cli", bin: { lock: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await expect(reviewCommand(context, { provider: "mock-fail" })).rejects.toThrow(
      "mock review failure",
    );
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(features[0]?.status).toBe("error");
    expect(features[0]?.lock).toBeNull();
    expect(await readdir(join(root, ".clawpatch/locks"))).toEqual([]);
    await rm(join(root, ".clawpatch"), { recursive: true, force: true });
  });

  it("does not create state directories for status before init", async () => {
    const root = await fixtureRoot("clawpatch-readonly-");
    const context = await makeContext(testOptions(root));

    await expect(statusCommand(context)).rejects.toThrow("not initialized");
    await expect(access(join(root, ".clawpatch"))).rejects.toThrow();
  });

  it("loads config from custom state directories", async () => {
    const root = await fixtureRoot("clawpatch-custom-state-root-");
    const stateDir = await fixtureRoot("clawpatch-custom-state-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "custom-state",
        scripts: { test: "node --test" },
      }),
    );
    await writeFixture(root, "package-lock.json", "{}");
    const options = { ...testOptions(root), stateDir };
    const context = await makeContext(options);

    await initCommand(context, {});
    const config = await loadConfig(root, options);

    expect(config.commands.test).toBe("npm run test");
  });

  it("clean-locks requeues claimed features", async () => {
    const root = await fixtureRoot("clawpatch-clean-locks-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "clean-locks", bin: { clean: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));

    await initCommand(context, {});
    await mapCommand(context);
    const feature = (await readFeatures(paths))[0];
    expect(feature).toBeDefined();
    await claimFeature(paths, feature!.featureId, {
      lockedByRunId: "run",
      lockedAt: new Date().toISOString(),
      hostname: "test",
      pid: 1,
    });
    expect(await readdir(paths.locks)).toEqual([`${feature!.featureId}.json`]);
    await cleanLocksCommand(context);
    const cleaned = (await readFeatures(paths))[0];

    expect(cleaned?.status).toBe("pending");
    expect(cleaned?.lock).toBeNull();
    expect(await readdir(paths.locks)).toEqual([]);
  });

  it("surfaces crash-window lock files in status", async () => {
    const root = await fixtureRoot("clawpatch-file-lock-status-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "file-lock-status",
        bin: { clean: "src/index.ts" },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));

    await initCommand(context, {});
    await mapCommand(context);
    const feature = (await readFeatures(paths))[0];
    expect(feature).toBeDefined();
    await writeFixture(
      root,
      `.clawpatch/locks/${feature!.featureId}.json`,
      `${JSON.stringify({
        lockedByRunId: "interrupted",
        lockedAt: new Date().toISOString(),
        hostname: "test",
        pid: 1,
      })}\n`,
    );

    expect(await statusCommand(context)).toMatchObject({
      activeLocks: 1,
      lockFiles: 1,
    });
  });

  it("cleans interrupted review locks through the CLI entrypoint", async () => {
    const root = await fixtureRoot("clawpatch-clean-locks-cli-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "clean-locks-cli",
        bin: { clean: "src/index.ts" },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");

    await runCli(["--root", root, "init", "--json"]);
    await runCli(["--root", root, "map", "--json"]);

    const paths = statePaths(join(root, ".clawpatch"));
    const feature = (await readFeatures(paths))[0];
    expect(feature).toBeDefined();
    await claimFeature(paths, feature!.featureId, {
      lockedByRunId: "interrupted",
      lockedAt: new Date().toISOString(),
      hostname: "test",
      pid: 1,
    });

    const output = await runCli(["--root", root, "clean-locks", "--json"]);
    const cleaned = (await readFeatures(paths))[0];

    expect(JSON.parse(output.stdout)).toMatchObject({
      cleared: 1,
      lockFilesCleared: 1,
    });
    expect(cleaned?.status).toBe("pending");
    expect(cleaned?.lock).toBeNull();
    expect(await readdir(paths.locks)).toEqual([]);
  });

  it("filters state files from successful fix results", async () => {
    const root = await fixtureRoot("clawpatch-filter-state-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const fixed = await fixCommand(context, { finding });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(fixed).toMatchObject({ status: "applied", filesChanged: 0 });
    expect(patches[0]?.filesChanged).toEqual([]);
    await expect(access(join(root, "SHOULD_NOT_RUN_PROVIDER_COMMANDS"))).rejects.toThrow();
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("includes feature-specific validation in fix dry-run output", async () => {
    const root = await fixtureRoot("clawpatch-feature-validation-dry-run-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const paths = statePaths(join(root, ".clawpatch"));
    const feature = (await readFeatures(paths))[0];
    const featureCommand = 'node -e "process.exit(0)"';
    await writeFeature(paths, {
      ...feature!,
      tests: [{ path: "src/index.test.ts", command: featureCommand }],
    });
    const fixed = await fixCommand(context, { finding, dryRun: true });
    const patches = await readPatchAttempts(paths);

    expect(fixed).toMatchObject({ dryRun: true, validation: featureCommand });
    expect(patches).toEqual([]);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("includes evidence, context, and tests in fix prompts", async () => {
    const root = await fixtureRoot("clawpatch-fix-prompt-context-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await writeFixture(root, "src/helper.ts", "export const helper = true;\n");
    await writeFixture(root, "src/index.test.ts", "expect(true).toBe(true);\n");
    await writeFixture(root, ".env", "SECRET=do-not-send\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const findingId = reviewed.next.split(" ").at(-1) ?? "";
    const paths = statePaths(join(root, ".clawpatch"));
    const feature = (await readFeatures(paths))[0]!;
    const featureWithContext: FeatureRecord = {
      ...feature,
      ownedFiles: [{ path: "src/helper.ts", reason: "first capped file" }, ...feature.ownedFiles],
      contextFiles: [{ path: "src/helper.ts", reason: "helper context" }],
      tests: [{ path: "src/index.test.ts", command: "npm test" }],
    };
    const finding = (await readFinding(paths, findingId))!;
    const findingWithUnownedEvidence = {
      ...finding,
      evidence: [
        {
          path: ".env",
          startLine: 1,
          endLine: 1,
          symbol: null,
          quote: "SECRET",
        },
        ...finding.evidence,
      ],
    };
    const promptConfig = await loadConfig(root, testOptions(root));
    const prompt = await buildFixPrompt(root, findingWithUnownedEvidence, featureWithContext, {
      ...promptConfig,
      review: {
        ...promptConfig.review,
        maxOwnedFiles: 1,
      },
    });

    expect(prompt).toContain("--- src/index.ts");
    expect(prompt).toContain("--- src/helper.ts");
    expect(prompt).toContain("--- src/index.test.ts");
    expect(prompt).not.toContain("SECRET=do-not-send");
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("records already-dirty files changed during fix validation", async () => {
    const root = await fixtureRoot("clawpatch-fix-dirty-snapshot-");
    await initGit(root);
    const config = defaultConfig();
    await writeFixture(
      root,
      "clawpatch.config.json",
      JSON.stringify(
        {
          ...config,
          provider: { name: "mock", model: null },
          commands: {
            ...config.commands,
            format:
              "node -e \"require('node:fs').appendFileSync('src/index.ts','// validation touch\\n')\"",
          },
          git: { ...config.git, requireCleanWorktreeForFix: false },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "buggy",
        bin: { buggy: "src/index.ts" },
        scripts: {},
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await checkCommand(root, "git add clawpatch.config.json package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    await writeFixture(
      root,
      "src/index.ts",
      "export const value = 'TODO_BUG';\n// pre-existing user change\n",
    );
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const fixed = await fixCommand(context, { finding });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(fixed).toMatchObject({ status: "applied", filesChanged: 1 });
    expect(patches[0]?.filesChanged).toEqual(["src/index.ts"]);
  });

  it("records dirty files removed during fix validation", async () => {
    const root = await fixtureRoot("clawpatch-fix-dirty-delete-");
    await initGit(root);
    const config = defaultConfig();
    await writeFixture(
      root,
      "clawpatch.config.json",
      JSON.stringify(
        {
          ...config,
          provider: { name: "mock", model: null },
          commands: {
            ...config.commands,
            format: "node -e \"require('node:fs').unlinkSync('src/scratch.txt')\"",
          },
          git: { ...config.git, requireCleanWorktreeForFix: false },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "buggy",
        bin: { buggy: "src/index.ts" },
        scripts: {},
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await checkCommand(root, "git add clawpatch.config.json package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    await writeFixture(root, "src/scratch.txt", "temporary user work\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const fixed = await fixCommand(context, { finding });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(fixed).toMatchObject({ status: "applied", filesChanged: 1 });
    expect(patches[0]?.filesChanged).toEqual(["src/scratch.txt"]);
  });

  it("records changes inside pre-existing untracked directories", async () => {
    const root = await fixtureRoot("clawpatch-fix-dirty-untracked-dir-");
    await initGit(root);
    const config = defaultConfig();
    await writeFixture(
      root,
      "clawpatch.config.json",
      JSON.stringify(
        {
          ...config,
          provider: { name: "mock", model: null },
          commands: {
            ...config.commands,
            format:
              "node -e \"require('node:fs').appendFileSync('scratch/note.txt','validation touch\\n')\"",
          },
          git: { ...config.git, requireCleanWorktreeForFix: false },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "buggy",
        bin: { buggy: "src/index.ts" },
        scripts: {},
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await checkCommand(root, "git add clawpatch.config.json package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    await writeFixture(root, "scratch/note.txt", "pre-existing user work\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const fixed = await fixCommand(context, { finding });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(fixed).toMatchObject({ status: "applied", filesChanged: 1 });
    expect(patches[0]?.filesChanged).toEqual(["scratch/note.txt"]);
  });

  posixFileModeIt("records mode-only changes to already-dirty files", async () => {
    const root = await fixtureRoot("clawpatch-fix-dirty-mode-");
    await initGit(root);
    await checkCommand(root, "git config core.filemode true");
    const config = defaultConfig();
    await writeFixture(
      root,
      "clawpatch.config.json",
      JSON.stringify(
        {
          ...config,
          provider: { name: "mock", model: null },
          commands: {
            ...config.commands,
            format: "chmod +x script.sh",
          },
          git: { ...config.git, requireCleanWorktreeForFix: false },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "buggy",
        bin: { buggy: "src/index.ts" },
        scripts: {},
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await writeFixture(root, "script.sh", "#!/bin/sh\necho before\n");
    await checkCommand(root, "git add clawpatch.config.json package.json src/index.ts script.sh");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    await writeFixture(root, "script.sh", "#!/bin/sh\necho before\necho dirty\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const fixed = await fixCommand(context, { finding });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(fixed).toMatchObject({ status: "applied", filesChanged: 1 });
    expect(patches[0]?.filesChanged).toEqual(["script.sh"]);
  });

  symlinkIt("fingerprints dirty symlinks without reading external targets", async () => {
    const root = await fixtureRoot("clawpatch-fix-dirty-symlink-");
    const external = await fixtureRoot("clawpatch-fix-dirty-symlink-external-");
    const externalPath = join(external, "target.txt");
    await initGit(root);
    await writeFixture(external, "target.txt", "secret\n");
    const config = defaultConfig();
    const externalMutation = `require('node:fs').appendFileSync(${JSON.stringify(
      externalPath,
    )}, 'changed\\n')`;
    await writeFixture(
      root,
      "clawpatch.config.json",
      JSON.stringify(
        {
          ...config,
          provider: { name: "mock", model: null },
          commands: {
            ...config.commands,
            format: `node -e ${JSON.stringify(externalMutation)}`,
          },
          git: { ...config.git, requireCleanWorktreeForFix: false },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "buggy",
        bin: { buggy: "src/index.ts" },
        scripts: {},
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await checkCommand(root, "git add clawpatch.config.json package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    await symlink(externalPath, join(root, "src/link.txt"));
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const fixed = await fixCommand(context, { finding });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(fixed).toMatchObject({ status: "applied", filesChanged: 0 });
    expect(patches[0]?.filesChanged).toEqual([]);
    expect(await readFile(externalPath, "utf8")).toContain("changed");
  });

  it("suppresses configured test validation for persistent feature tests", async () => {
    const root = await fixtureRoot("clawpatch-feature-validation-suppressed-test-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "buggy",
        bin: { buggy: "src/index.ts" },
        scripts: {
          format: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(9)"',
        },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const paths = statePaths(join(root, ".clawpatch"));
    const feature = (await readFeatures(paths))[0];
    await writeFeature(paths, {
      ...feature!,
      tests: [{ path: "src/index.test.ts", command: null }],
      tags: [...feature!.tags, "validation:test-suppressed"],
    });
    const fixed = await fixCommand(context, { finding, dryRun: true });

    expect(fixed).toMatchObject({ dryRun: true, validation: "npm run format" });
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("fails fix when feature-specific validation fails", async () => {
    const root = await fixtureRoot("clawpatch-feature-validation-fail-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const paths = statePaths(join(root, ".clawpatch"));
    const feature = (await readFeatures(paths))[0];
    const featureCommand = 'node -e "process.exit(7)"';
    await writeFeature(paths, {
      ...feature!,
      tests: [{ path: "src/index.test.ts", command: featureCommand }],
    });
    await expect(fixCommand(context, { finding })).rejects.toMatchObject({
      exitCode: 6,
    });
    const [patches, updatedFinding] = await Promise.all([
      readPatchAttempts(paths),
      readFinding(paths, finding),
    ]);

    expect(patches[0]?.status).toBe("failed");
    expect(patches[0]?.commandsRun).toHaveLength(1);
    expect(patches[0]?.commandsRun[0]).toMatchObject({
      command: featureCommand,
      exitCode: 7,
    });
    expect(updatedFinding?.status).toBe("open");
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("deduplicates feature-specific and configured fix validation commands", async () => {
    const root = await fixtureRoot("clawpatch-feature-validation-dedupe-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "buggy",
        bin: { buggy: "src/index.ts" },
        scripts: {
          format: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
        },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const paths = statePaths(join(root, ".clawpatch"));
    const feature = (await readFeatures(paths))[0];
    const featureCommand = 'node -e "process.exit(0)"';
    await writeFeature(paths, {
      ...feature!,
      tests: [
        { path: "src/index.test.ts", command: "" },
        { path: "src/index.test.ts", command: featureCommand },
        { path: "src/index.test.ts", command: "npm run test" },
      ],
    });
    const fixed = await fixCommand(context, { finding });
    const patches = await readPatchAttempts(paths);

    expect(fixed).toMatchObject({ status: "applied", commands: 3 });
    expect(patches[0]?.commandsRun.map((result) => result.command)).toEqual([
      "npm run format",
      featureCommand,
      "npm run test",
    ]);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("blocks fix when git cleanliness cannot be verified", async () => {
    const root = await fixtureRoot("clawpatch-non-git-fix-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    await expect(fixCommand(context, { finding })).rejects.toMatchObject({
      code: "dirty-worktree",
    });

    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("allows fix in non-Git roots when the Codex Git check is explicitly skipped", async () => {
    const root = await fixtureRoot("clawpatch-non-git-fix-skip-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const paths = statePaths(join(root, ".clawpatch"));
    const feature = (await readFeatures(paths))[0];
    await writeFeature(paths, {
      ...feature!,
      tests: [
        {
          path: "src/index.test.ts",
          command: "node -e \"require('node:fs').appendFileSync('src/index.ts','// fixed\\n')\"",
        },
      ],
    });
    const fixed = await fixCommand(context, {
      finding,
      skipGitRepoCheck: true,
    });
    const patches = await readPatchAttempts(paths);

    expect(fixed).toMatchObject({
      dryRun: false,
      status: "applied",
      filesChanged: 1,
    });
    expect(patches[0]?.filesChanged).toEqual(["src/index.ts"]);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("fails fix when configured validation fails", async () => {
    const root = await fixtureRoot("clawpatch-validation-fail-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "buggy",
        bin: { buggy: "src/index.ts" },
        scripts: { test: "exit 1" },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    await expect(fixCommand(context, { finding })).rejects.toMatchObject({
      exitCode: 6,
    });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(patches[0]?.status).toBe("failed");
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("marks review runs failed on lock conflicts", async () => {
    const root = await fixtureRoot("clawpatch-lock-conflict-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "lock-conflict", bin: { lock: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));

    await initCommand(context, {});
    await mapCommand(context);
    const feature = (await readFeatures(paths))[0];
    expect(feature).toBeDefined();
    await writeFeature(paths, {
      ...feature!,
      lock: {
        lockedByRunId: "existing",
        lockedAt: new Date().toISOString(),
        hostname: "test",
        pid: 1,
      },
    });

    await expect(reviewCommand(context, { feature: feature!.featureId })).rejects.toThrow(
      "feature locked",
    );
    const runs = await readRuns(paths);

    expect(runs[0]?.status).toBe("failed");
  });

  it("requeues changed reviewed features after remapping", async () => {
    const root = await fixtureRoot("clawpatch-requeue-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "requeue", scripts: { test: "echo old" } }),
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { limit: "2" });
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "requeue", scripts: { test: "echo new" } }),
    );
    await mapCommand(context);
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const testFeature = features.find((feature) => feature.title === "Package script test");

    expect(testFeature?.summary).toContain("echo new");
    expect(testFeature?.status).toBe("pending");
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("preserves finding status and patch links on repeated review", async () => {
    const root = await fixtureRoot("clawpatch-merge-finding-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "merge-finding", bin: { merge: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { limit: "1" });
    const paths = statePaths(join(root, ".clawpatch"));
    const finding = (await readFindings(paths))[0];
    expect(finding).toBeDefined();
    await writeFinding(paths, {
      ...finding!,
      status: "fixed",
      linkedPatchAttemptIds: ["pat_existing"],
    });
    await reviewCommand(context, { feature: finding!.featureId });
    const reviewedAgain = (await readFindings(paths))[0];

    expect(reviewedAgain?.status).toBe("fixed");
    expect(reviewedAgain?.linkedPatchAttemptIds).toEqual(["pat_existing"]);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("adds deslopify-only review instructions when requested", async () => {
    const root = await fixtureRoot("clawpatch-deslopify-prompt-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "deslopify-prompt" }));
    await writeFixture(root, "src/index.ts", "export function main() { return 1; }\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const project = await readProject(statePaths(join(root, ".clawpatch")));
    expect(project).toBeDefined();
    const prompt = await buildReviewPrompt(
      root,
      project!,
      {
        schemaVersion: 1,
        featureId: "feat_deslopify",
        title: "deslopify",
        summary: "deslopify",
        kind: "library",
        source: "test",
        confidence: "high",
        entrypoints: [{ path: "src/index.ts", symbol: null, route: null, command: null }],
        ownedFiles: [{ path: "src/index.ts", reason: "test" }],
        contextFiles: [],
        tests: [],
        tags: [],
        trustBoundaries: [],
        status: "pending",
        lock: null,
        findingIds: [],
        patchAttemptIds: [],
        analysisHistory: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      await loadConfig(root, testOptions(root)),
      "deslopify",
    );

    expect(prompt).toContain("Deslopify mode:");
    expect(prompt).toContain(
      'only simplification findings in category "maintainability" or "performance"',
    );
    expect(prompt).toContain("stay separate from normal review");
    expect(prompt).toContain("locally provable AI-slop patterns");
    expect(prompt).toContain("semantic duplication");
    expect(prompt).toContain("shadow modules and useless wrappers");
    expect(prompt).toContain("concrete code bloat");
    expect(prompt).toContain("dead legacy paths kept alive by tests");
    expect(prompt).toContain("cargo-cult defensive code");
    expect(prompt).toContain("tautological or coupled tests");
    expect(prompt).toContain("type/build silencing and band-aid hacks");
    expect(prompt).toContain("do not report file size");
    expect(prompt).toContain("do not report correctness, security, API contract");
  });

  it("injects --prompt-file content into the review prompt", async () => {
    const root = await fixtureRoot("clawpatch-prompt-file-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "prompt-file" }));
    await writeFixture(root, "src/index.ts", "export function main() { return 1; }\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const project = await readProject(statePaths(join(root, ".clawpatch")));
    expect(project).toBeDefined();
    const promptWithCustom = await buildReviewPrompt(
      root,
      project!,
      {
        schemaVersion: 1,
        featureId: "feat_prompt_file",
        title: "prompt-file",
        summary: "prompt-file",
        kind: "library",
        source: "test",
        confidence: "high",
        entrypoints: [{ path: "src/index.ts", symbol: null, route: null, command: null }],
        ownedFiles: [{ path: "src/index.ts", reason: "test" }],
        contextFiles: [],
        tests: [],
        tags: [],
        trustBoundaries: [],
        status: "pending",
        lock: null,
        findingIds: [],
        patchAttemptIds: [],
        analysisHistory: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      await loadConfig(root, testOptions(root)),
      "default",
      "Focus exclusively on race conditions and lock ordering bugs.",
    );

    expect(promptWithCustom).toContain(
      "Additional reviewer guidance (provided via --prompt-file):",
    );
    expect(promptWithCustom).toContain(
      "Focus exclusively on race conditions and lock ordering bugs.",
    );
    // Custom guidance must land before the JSON shape and file blocks so
    // the model reads it as setup, not as part of the response template.
    const guidanceIdx = promptWithCustom.indexOf("Additional reviewer guidance");
    const jsonIdx = promptWithCustom.indexOf("JSON shape:");
    expect(guidanceIdx).toBeGreaterThan(0);
    expect(guidanceIdx).toBeLessThan(jsonIdx);
  });

  it("leaves the review prompt unchanged when --prompt-file is omitted", async () => {
    const root = await fixtureRoot("clawpatch-prompt-file-omit-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "prompt-file-omit" }));
    await writeFixture(root, "src/index.ts", "export function main() { return 1; }\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const project = await readProject(statePaths(join(root, ".clawpatch")));
    expect(project).toBeDefined();
    const baseline = await buildReviewPrompt(
      root,
      project!,
      {
        schemaVersion: 1,
        featureId: "feat_prompt_file_omit",
        title: "prompt-file-omit",
        summary: "prompt-file-omit",
        kind: "library",
        source: "test",
        confidence: "high",
        entrypoints: [{ path: "src/index.ts", symbol: null, route: null, command: null }],
        ownedFiles: [{ path: "src/index.ts", reason: "test" }],
        contextFiles: [],
        tests: [],
        tags: [],
        trustBoundaries: [],
        status: "pending",
        lock: null,
        findingIds: [],
        patchAttemptIds: [],
        analysisHistory: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      await loadConfig(root, testOptions(root)),
    );

    expect(baseline).not.toContain("Additional reviewer guidance");
  });

  it("parses --prompt-file as a review value flag", () => {
    expect(parseArgs(["review", "--prompt-file", "/tmp/foo.md"]).flags).toMatchObject({
      promptFile: "/tmp/foo.md",
    });
  });

  it("runs review --prompt-file through the CLI entrypoint", async () => {
    const root = await fixtureRoot("clawpatch-prompt-file-cli-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "prompt-file-cli" }));

    await runCli(["--root", root, "--json", "--quiet", "init"]);

    await expect(
      runCli([
        "--root",
        root,
        "--json",
        "--quiet",
        "review",
        "--prompt-file",
        join(root, "missing.md"),
      ]),
    ).rejects.toThrow("failed to read --prompt-file");
  });

  it("writes a tribunal-shaped JSONL ledger when --export-tribunal-ledger is set", async () => {
    const root = await fixtureRoot("clawpatch-export-tribunal-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "export-tribunal",
        bin: { app: "src/index.ts" },
        scripts: { test: "vitest run" },
      }),
    );
    await writeFixture(root, "tsconfig.json", "{}");
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const exportPath = join(root, "tribunal-export.jsonl");
    const reviewed = (await reviewCommand(context, {
      limit: "1",
      exportTribunalLedger: exportPath,
    })) as { findings: number; exportTribunalLedger?: string };

    expect(reviewed.findings).toBeGreaterThan(0);
    expect(reviewed.exportTribunalLedger).toBe(exportPath);

    const contents = await readFile(exportPath, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(reviewed.findings);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({
      kind: "clawpatch-review",
      plan_id: null,
      round: 1,
      agent_pubkey: null,
      agent_label: expect.stringMatching(/^clawpatch-/u),
      claim_uri: null,
      stake: null,
      signature: null,
    });
    expect(first["finding_id"]).toEqual(expect.stringMatching(/^fnd_/u));
    expect(first["claim_hash"]).toEqual(expect.any(String));
    expect(first["timestamp"]).toEqual(expect.any(String));
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("omits exportTribunalLedger from the result when the flag is absent", async () => {
    const root = await fixtureRoot("clawpatch-export-tribunal-omit-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "export-omit" }));
    await writeFixture(root, "tsconfig.json", "{}");
    await writeFixture(root, "src/index.ts", "export const value = 'ok';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as Record<string, unknown>;
    expect(Object.hasOwn(reviewed, "exportTribunalLedger")).toBe(false);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("parses --export-tribunal-ledger as a review value flag", () => {
    expect(parseArgs(["review", "--export-tribunal-ledger", "/tmp/out.jsonl"]).flags).toMatchObject(
      { exportTribunalLedger: "/tmp/out.jsonl" },
    );
  });

  it("runs review --export-tribunal-ledger through the CLI entrypoint", async () => {
    const root = await fixtureRoot("clawpatch-export-tribunal-cli-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "export-tribunal-cli",
        bin: { app: "src/index.ts" },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";

    try {
      await runCli(["--root", root, "--json", "--quiet", "init"]);
      await runCli(["--root", root, "--json", "--quiet", "map"]);
      const exportPath = join(root, "tribunal-cli.jsonl");
      const reviewed = await runCli([
        "--root",
        root,
        "--json",
        "--quiet",
        "review",
        "--limit",
        "1",
        "--export-tribunal-ledger",
        exportPath,
      ]);

      expect(JSON.parse(reviewed.stdout)).toMatchObject({
        findings: 1,
        exportTribunalLedger: exportPath,
      });
      expect(await readFile(exportPath, "utf8")).toContain('"kind":"clawpatch-review"');
    } finally {
      delete process.env["CLAWPATCH_PROVIDER"];
    }
  });

  it("filters non-simplification findings in deslopify mode", async () => {
    const root = await fixtureRoot("clawpatch-deslopify-filter-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "deslopify-filter" }));
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = await reviewCommand(context, {
      limit: "1",
      mode: "deslopify",
    });
    const paths = statePaths(join(root, ".clawpatch"));
    const findings = await readFindings(paths);

    expect(reviewed).toMatchObject({ findings: 0 });
    expect(findings).toHaveLength(0);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("applies the finding cap after deslopify mode filtering", async () => {
    const root = await fixtureRoot("clawpatch-deslopify-cap-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "deslopify-cap" }));
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG DESLOPIFY_LATE';\n");
    const previousProvider = process.env["CLAWPATCH_PROVIDER"];
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    try {
      const context = await makeContext(testOptions(root));
      const config = defaultConfig();
      config.review.maxFindingsPerFeature = 1;

      await initCommand(context, {});
      await writeFixture(root, ".clawpatch/config.json", JSON.stringify(config, null, 2));
      await mapCommand(context);
      const paths = statePaths(join(root, ".clawpatch"));
      const sourceFeature = (await readFeatures(paths)).find((feature) =>
        feature.ownedFiles.some((file) => file.path === "src/index.ts"),
      );
      if (sourceFeature === undefined) {
        throw new Error("missing source feature");
      }
      const reviewed = await reviewCommand(context, {
        feature: sourceFeature.featureId,
        mode: "deslopify",
      });
      const findings = await readFindings(paths);

      expect(reviewed).toMatchObject({ findings: 1 });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        title: "Late simplification finding",
        category: "maintainability",
      });
    } finally {
      if (previousProvider === undefined) {
        delete process.env["CLAWPATCH_PROVIDER"];
      } else {
        process.env["CLAWPATCH_PROVIDER"] = previousProvider;
      }
    }
  });

  symlinkIt("does not include escaped feature paths in prompts", async () => {
    const root = await fixtureRoot("clawpatch-path-escape-");
    const siblingSecret = join(root, "..", "secret.txt");
    await writeFixture(root, "package.json", JSON.stringify({ name: "path-escape" }));
    await writeFixture(root, "../secret.txt", "do-not-read\n");
    await mkdir(join(root, "src"), { recursive: true });
    await symlink(siblingSecret, join(root, "src/index.ts"));
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const project = await readProject(statePaths(join(root, ".clawpatch")));
    expect(project).toBeDefined();
    const prompt = await buildReviewPrompt(
      root,
      project!,
      {
        schemaVersion: 1,
        featureId: "feat_escape",
        title: "escape",
        summary: siblingSecret,
        kind: "config",
        source: "test",
        confidence: "high",
        entrypoints: [{ path: "../secret.txt", symbol: null, route: null, command: null }],
        ownedFiles: [{ path: "../secret.txt", reason: "test" }],
        contextFiles: [],
        tests: [],
        tags: [],
        trustBoundaries: [],
        status: "pending",
        lock: null,
        findingIds: [],
        patchAttemptIds: [],
        analysisHistory: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      await loadConfig(root, testOptions(root)),
    );

    expect(prompt).toContain("[skipped: path escapes repository root]");
    expect(prompt).not.toContain("do-not-read");

    const symlinkPrompt = await buildReviewPrompt(
      root,
      project!,
      {
        schemaVersion: 1,
        featureId: "feat_symlink",
        title: "symlink",
        summary: "symlink",
        kind: "config",
        source: "test",
        confidence: "high",
        entrypoints: [{ path: "src/index.ts", symbol: null, route: null, command: null }],
        ownedFiles: [{ path: "src/index.ts", reason: "test" }],
        contextFiles: [],
        tests: [],
        tags: [],
        trustBoundaries: [],
        status: "pending",
        lock: null,
        findingIds: [],
        patchAttemptIds: [],
        analysisHistory: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      await loadConfig(root, testOptions(root)),
    );

    expect(symlinkPrompt).toContain("[skipped: path escapes repository root]");
    expect(symlinkPrompt).not.toContain("do-not-read");
  });

  it("previews a PR for an applied patch attempt", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "open-pr", bin: { open: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await initGit(root);
    await checkCommand(root, "git add package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const previousProvider = process.env["CLAWPATCH_PROVIDER"];
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    try {
      const context = await makeContext(testOptions(root));
      const paths = statePaths(join(root, ".clawpatch"));
      await initCommand(context, {});
      await mapCommand(context);
      await reviewCommand(context, { limit: "1" });
      const finding = (await readFindings(paths))[0];
      expect(finding).toBeDefined();
      await writeFixture(root, "src/index.ts", "export const value = 'fixed';\n");
      const baseSha = (await runCommand("git rev-parse HEAD", root)).stdout.trim();
      const now = new Date().toISOString();
      const patch: PatchAttempt = {
        schemaVersion: 1,
        patchAttemptId: "pat_open_pr",
        findingIds: [finding!.findingId],
        featureIds: [finding!.featureId],
        status: "applied",
        plan: "Replace the marker value.",
        filesChanged: ["src/index.ts"],
        commandsRun: [],
        testResults: [
          {
            command: "pnpm test",
            cwd: root,
            exitCode: 0,
            durationMs: 1,
            stdout: "",
            stderr: "",
          },
        ],
        provider: null,
        git: {
          baseSha,
          commitSha: null,
          branchName: null,
          prUrl: null,
        },
        createdAt: now,
        updatedAt: now,
      };
      await writePatchAttempt(paths, patch);

      const preview = await openPrCommand(context, {
        patch: patch.patchAttemptId,
        base: "main",
        branch: "clawpatch/pat_open_pr",
        dryRun: true,
      });
      const stored = (await readPatchAttempts(paths)).find(
        (candidate) => candidate.patchAttemptId === patch.patchAttemptId,
      );
      const cliPreview = await runCli([
        "--root",
        root,
        "open-pr",
        "--patch",
        patch.patchAttemptId,
        "--base",
        "main",
        "--branch",
        "clawpatch/pat_open_pr",
        "--dry-run",
      ]);

      expect(preview).toMatchObject({
        dryRun: true,
        patchAttempt: patch.patchAttemptId,
        branch: "clawpatch/pat_open_pr",
        base: "main",
      });
      expect(preview).toMatchObject({
        body: expect.stringContaining("pat_open_pr"),
        commands: expect.arrayContaining([
          expect.stringContaining("gh pr create --base main --head clawpatch/pat_open_pr"),
        ]),
      });
      expect(cliPreview.stdout).toContain("commandsPreview: git switch");
      expect(cliPreview.stdout).toContain("gh pr create --base main --head clawpatch/pat_open_pr");
      expect(stored?.git.prUrl).toBeNull();
    } finally {
      if (previousProvider === undefined) {
        delete process.env["CLAWPATCH_PROVIDER"];
      } else {
        process.env["CLAWPATCH_PROVIDER"] = previousProvider;
      }
    }
  });

  it("uses a patch branch when the PR base is unknown", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-unknown-base-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "open-pr-unknown-base", bin: { open: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await initGit(root);
    await checkCommand(root, "git branch -m develop");
    await checkCommand(root, "git add package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    await writeFixture(root, "src/index.ts", "export const value = 'fixed';\n");
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_unknown_base",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Replace the marker value.",
      filesChanged: ["src/index.ts"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: root,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: "develop",
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });

    const preview = await openPrCommand(context, {
      patch: "pat_open_pr_unknown_base",
      dryRun: true,
    });

    expect(preview).toMatchObject({
      branch: "clawpatch/pat_open_pr_unknown_base",
      base: null,
    });
    expect(preview).toMatchObject({
      commands: expect.arrayContaining([
        expect.stringContaining("gh pr create --head clawpatch/pat_open_pr_unknown_base"),
      ]),
    });
    expect(preview).toMatchObject({
      commands: expect.not.arrayContaining([expect.stringContaining("--base main")]),
    });
  });

  it("previews PR commands with execution paths and draft flags", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-subdir-");
    const projectRoot = join(root, "packages/app");
    await writeFixture(
      root,
      "packages/app/package.json",
      JSON.stringify({ name: "open-pr-subdir", bin: { open: "src/index.ts" } }),
    );
    await writeFixture(root, "packages/app/src/index.ts", "export const value = 'TODO_BUG';\n");
    await initGit(root);
    await checkCommand(root, "git add packages");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const context = await makeContext(testOptions(projectRoot));
    const paths = statePaths(join(projectRoot, ".clawpatch"));
    await initCommand(context, {});
    await writeFixture(root, "packages/app/src/index.ts", "export const value = 'fixed';\n");
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_subdir",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Replace the marker value.",
      filesChanged: ["src/index.ts"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: projectRoot,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: null,
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });

    const preview = await openPrCommand(context, {
      patch: "pat_open_pr_subdir",
      base: "develop",
      branch: "clawpatch/pat_open_pr_subdir",
      draft: true,
      dryRun: true,
    });

    expect(preview).toMatchObject({
      commands: expect.arrayContaining([
        expect.stringContaining("git add -- ':(literal)packages/app/src/index.ts'"),
        expect.stringContaining("gh pr create --base develop --head clawpatch/pat_open_pr_subdir"),
        expect.stringContaining("--draft"),
      ]),
    });
  });

  symlinkIt("opens PRs from symlinked project roots with repo-relative patch paths", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-symlink-root-");
    const projectRoot = join(root, "packages/app");
    await writeFixture(
      root,
      "packages/app/package.json",
      JSON.stringify({ name: "open-pr-symlink-root" }),
    );
    await writeFixture(root, "packages/app/src/index.ts", "export const value = 'TODO_BUG';\n");
    await initGit(root);
    await checkCommand(root, "git add packages");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const origin = await fixtureRoot("clawpatch-open-pr-symlink-root-origin-");
    await checkCommand(root, `git init --bare -q ${origin}`);
    await checkCommand(root, `git remote add origin ${origin}`);
    const linkParent = await fixtureRoot("clawpatch-open-pr-symlink-root-link-");
    const linkedProjectRoot = join(linkParent, "app");
    await symlink(projectRoot, linkedProjectRoot);
    const context = await makeContext(testOptions(linkedProjectRoot));
    const paths = statePaths(join(linkedProjectRoot, ".clawpatch"));
    await initCommand(context, {});
    await writeFixture(root, "packages/app/src/index.ts", "export const value = 'fixed';\n");
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_symlink_root",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Replace the marker value.",
      filesChanged: ["src/index.ts"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: linkedProjectRoot,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: null,
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });
    const ghScripts = await fixtureRoot("clawpatch-open-pr-symlink-root-gh-");
    const successGh = await writeGhSuccessScript(
      ghScripts,
      "https://github.com/openclaw/clawpatch/pull/1004",
    );
    const previousGh = process.env["CLAWPATCH_GH"];
    try {
      process.env["CLAWPATCH_GH"] = successGh;
      const preview = (await openPrCommand(context, {
        patch: "pat_open_pr_symlink_root",
        base: "main",
        branch: "clawpatch/pat_open_pr_symlink_root",
        dryRun: true,
      })) as { commands: string[] };
      const opened = (await openPrCommand(context, {
        patch: "pat_open_pr_symlink_root",
        base: "main",
        branch: "clawpatch/pat_open_pr_symlink_root",
      })) as { commit: string; pr: string };
      const committed = await runCommand(`git show --name-only --format= ${opened.commit}`, root);

      expect(preview.commands).toContain("git add -- ':(literal)packages/app/src/index.ts'");
      expect(opened.pr).toBe("https://github.com/openclaw/clawpatch/pull/1004");
      expect(committed.stdout.trim()).toBe("packages/app/src/index.ts");
    } finally {
      if (previousGh === undefined) {
        delete process.env["CLAWPATCH_GH"];
      } else {
        process.env["CLAWPATCH_GH"] = previousGh;
      }
    }
  });

  symlinkIt("opens PRs for newly created dangling symlinks", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-symlink-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "open-pr-symlink" }));
    await initGit(root);
    await checkCommand(root, "git add package.json");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const origin = await fixtureRoot("clawpatch-open-pr-symlink-origin-");
    await checkCommand(root, `git init --bare -q ${origin}`);
    await checkCommand(root, `git remote add origin ${origin}`);
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    await symlink("missing-target", join(root, "link"));
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_symlink",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Add the symlink.",
      filesChanged: ["link"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: root,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: null,
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });
    const ghScripts = await fixtureRoot("clawpatch-open-pr-symlink-gh-");
    const successGh = await writeGhSuccessScript(
      ghScripts,
      "https://github.com/openclaw/clawpatch/pull/1003",
    );
    const previousGh = process.env["CLAWPATCH_GH"];
    try {
      process.env["CLAWPATCH_GH"] = successGh;
      const opened = (await openPrCommand(context, {
        patch: "pat_open_pr_symlink",
        base: "main",
        branch: "clawpatch/pat_open_pr_symlink",
      })) as { commit: string; pr: string };
      const committed = await runCommand(`git show --name-status --format= ${opened.commit}`, root);

      expect(opened.pr).toBe("https://github.com/openclaw/clawpatch/pull/1003");
      expect(committed.stdout.trim()).toBe("A\tlink");
    } finally {
      if (previousGh === undefined) {
        delete process.env["CLAWPATCH_GH"];
      } else {
        process.env["CLAWPATCH_GH"] = previousGh;
      }
    }
  });

  it("returns an existing PR URL without recreating it", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-existing-url-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "open-pr-existing-url" }));
    await writeFixture(root, "src/index.ts", "export const value = 'fixed';\n");
    await initGit(root);
    await checkCommand(root, "git add package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const commitSha = (await runCommand("git rev-parse HEAD", root)).stdout.trim();
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_existing_url",
      findingIds: [],
      featureIds: [],
      status: "validated",
      plan: "Already opened.",
      filesChanged: ["src/index.ts"],
      commandsRun: [],
      testResults: [],
      provider: null,
      git: {
        baseSha: commitSha,
        commitSha,
        branchName: "clawpatch/pat_open_pr_existing_url",
        prUrl: "https://github.com/openclaw/clawpatch/pull/1004",
      },
      createdAt: now,
      updatedAt: now,
    });
    const ghScripts = await fixtureRoot("clawpatch-open-pr-existing-url-gh-");
    const failingGh = await writeGhFailureScript(ghScripts);
    const previousGh = process.env["CLAWPATCH_GH"];
    try {
      process.env["CLAWPATCH_GH"] = failingGh;
      await expect(
        openPrCommand(context, {
          patch: "pat_open_pr_existing_url",
          base: "main",
        }),
      ).resolves.toMatchObject({
        pr: "https://github.com/openclaw/clawpatch/pull/1004",
        branch: "clawpatch/pat_open_pr_existing_url",
        commit: commitSha,
      });
    } finally {
      if (previousGh === undefined) {
        delete process.env["CLAWPATCH_GH"];
      } else {
        process.env["CLAWPATCH_GH"] = previousGh;
      }
    }
  });

  it("persists the patch commit before failing external PR creation", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-retry-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "open-pr-retry", bin: { open: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await initGit(root);
    await checkCommand(root, "git add package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const origin = await fixtureRoot("clawpatch-open-pr-retry-origin-");
    await checkCommand(root, `git init --bare -q ${origin}`);
    await checkCommand(root, `git remote add origin ${origin}`);
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    await writeFixture(root, "src/index.ts", "export const value = 'fixed';\n");
    const now = new Date().toISOString();
    const patch: PatchAttempt = {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_retry",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Replace the marker value.",
      filesChanged: ["src/index.ts"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: root,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: null,
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    };
    await writePatchAttempt(paths, patch);
    const ghScripts = await fixtureRoot("clawpatch-open-pr-gh-");
    const failingGh = await writeGhFailureScript(ghScripts);
    const successGh = await writeGhSuccessScript(
      ghScripts,
      "https://github.com/openclaw/clawpatch/pull/999",
    );
    const previousGh = process.env["CLAWPATCH_GH"];
    try {
      process.env["CLAWPATCH_GH"] = failingGh;
      await expect(
        openPrCommand(context, {
          patch: patch.patchAttemptId,
          base: "main",
          branch: "clawpatch/pat_open_pr_retry",
        }),
      ).rejects.toMatchObject({ code: "github-failure" });
      const afterFailure = (await readPatchAttempts(paths)).find(
        (candidate) => candidate.patchAttemptId === patch.patchAttemptId,
      );
      expect(afterFailure?.git.commitSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(afterFailure?.git.branchName).toBe("clawpatch/pat_open_pr_retry");
      const recordedCommit = afterFailure?.git.commitSha;
      if (recordedCommit === null || recordedCommit === undefined) {
        throw new Error("missing recorded patch commit");
      }

      await writeFixture(root, "src/unrelated.ts", "export const unrelated = true;\n");
      await checkCommand(root, "git add src/unrelated.ts");
      await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "unrelated"');
      const advancedHead = (await runCommand("git rev-parse HEAD", root)).stdout.trim();
      expect(advancedHead).not.toBe(recordedCommit);

      process.env["CLAWPATCH_GH"] = successGh;
      await expect(
        openPrCommand(context, {
          patch: patch.patchAttemptId,
          base: "main",
        }),
      ).resolves.toMatchObject({
        pr: "https://github.com/openclaw/clawpatch/pull/999",
      });
      const remoteHead = (
        await runCommand("git ls-remote --heads origin clawpatch/pat_open_pr_retry", root)
      ).stdout
        .trim()
        .split(/\s+/u)[0];
      expect(remoteHead).toBe(recordedCommit);
    } finally {
      if (previousGh === undefined) {
        delete process.env["CLAWPATCH_GH"];
      } else {
        process.env["CLAWPATCH_GH"] = previousGh;
      }
    }
  });

  it("creates first PR branches from the recorded patch base", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-recorded-base-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "open-pr-recorded-base", bin: { open: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await initGit(root);
    await checkCommand(root, "git add package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const baseSha = (await runCommand("git rev-parse HEAD", root)).stdout.trim();
    const origin = await fixtureRoot("clawpatch-open-pr-recorded-base-origin-");
    await checkCommand(root, `git init --bare -q ${origin}`);
    await checkCommand(root, `git remote add origin ${origin}`);
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    await writeFixture(root, "src/index.ts", "export const value = 'fixed';\n");
    await writeFixture(root, "src/unrelated.ts", "export const unrelated = true;\n");
    await checkCommand(root, "git add src/unrelated.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "unrelated"');
    const advancedHead = (await runCommand("git rev-parse HEAD", root)).stdout.trim();
    expect(advancedHead).not.toBe(baseSha);
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_recorded_base",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Replace the marker value.",
      filesChanged: ["src/index.ts"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: root,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha,
        commitSha: null,
        branchName: null,
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });
    const ghScripts = await fixtureRoot("clawpatch-open-pr-recorded-base-gh-");
    const successGh = await writeGhSuccessScript(
      ghScripts,
      "https://github.com/openclaw/clawpatch/pull/1005",
    );
    const previousGh = process.env["CLAWPATCH_GH"];
    try {
      process.env["CLAWPATCH_GH"] = successGh;
      const opened = (await openPrCommand(context, {
        patch: "pat_open_pr_recorded_base",
        base: "main",
        branch: "clawpatch/pat_open_pr_recorded_base",
      })) as { commit: string; pr: string };
      const parent = (
        await runCommand(`git show -s --format=%P ${opened.commit}`, root)
      ).stdout.trim();
      const committed = await runCommand(`git show --name-only --format= ${opened.commit}`, root);

      expect(opened.pr).toBe("https://github.com/openclaw/clawpatch/pull/1005");
      expect(parent).toBe(baseSha);
      expect(committed.stdout.trim().split("\n")).toEqual(["src/index.ts"]);
    } finally {
      if (previousGh === undefined) {
        delete process.env["CLAWPATCH_GH"];
      } else {
        process.env["CLAWPATCH_GH"] = previousGh;
      }
    }
  });

  it("switches to an existing patch branch when opening a PR", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-existing-branch-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "open-pr-existing-branch", bin: { open: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await initGit(root);
    await checkCommand(root, "git add package.json src/index.ts");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const origin = await fixtureRoot("clawpatch-open-pr-existing-branch-origin-");
    await checkCommand(root, `git init --bare -q ${origin}`);
    await checkCommand(root, `git remote add origin ${origin}`);
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    await checkCommand(root, "git branch clawpatch/pat_open_pr_existing_branch");
    await writeFixture(root, "src/index.ts", "export const value = 'fixed';\n");
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_existing_branch",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Replace the marker value.",
      filesChanged: ["src/index.ts"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: root,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: "clawpatch/pat_open_pr_existing_branch",
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });
    const ghScripts = await fixtureRoot("clawpatch-open-pr-existing-branch-gh-");
    const successGh = await writeGhSuccessScript(
      ghScripts,
      "https://github.com/openclaw/clawpatch/pull/1002",
    );
    const previousGh = process.env["CLAWPATCH_GH"];
    try {
      process.env["CLAWPATCH_GH"] = successGh;
      const preview = (await openPrCommand(context, {
        patch: "pat_open_pr_existing_branch",
        base: "main",
        dryRun: true,
      })) as { commands: string[] };
      const opened = (await openPrCommand(context, {
        patch: "pat_open_pr_existing_branch",
        base: "main",
      })) as { branch: string; pr: string };
      const currentBranch = (await runCommand("git branch --show-current", root)).stdout.trim();

      expect(preview.commands).toEqual(
        expect.arrayContaining(["git switch clawpatch/pat_open_pr_existing_branch"]),
      );
      expect(preview.commands).toEqual(
        expect.not.arrayContaining(["git switch -c clawpatch/pat_open_pr_existing_branch"]),
      );
      expect(opened.pr).toBe("https://github.com/openclaw/clawpatch/pull/1002");
      expect(opened.branch).toBe("clawpatch/pat_open_pr_existing_branch");
      expect(currentBranch).toBe("clawpatch/pat_open_pr_existing_branch");
    } finally {
      if (previousGh === undefined) {
        delete process.env["CLAWPATCH_GH"];
      } else {
        process.env["CLAWPATCH_GH"] = previousGh;
      }
    }
  });

  it("opens PRs for quoted paths without committing pre-staged state", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-pathspec-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "open-pr-pathspec", bin: { open: "docs/foo bar.md" } }),
    );
    await writeFixture(root, "docs/foo bar.md", "TODO_BUG\n");
    await initGit(root);
    await checkCommand(root, "git add package.json docs");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const origin = await fixtureRoot("clawpatch-open-pr-pathspec-origin-");
    await checkCommand(root, `git init --bare -q ${origin}`);
    await checkCommand(root, `git remote add origin ${origin}`);
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    await checkCommand(root, "git add .clawpatch/config.json");
    await writeFixture(root, "docs/foo bar.md", "fixed\n");
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_pathspec",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Replace the marker value.",
      filesChanged: ["docs/foo bar.md"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: root,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: null,
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });
    const ghScripts = await fixtureRoot("clawpatch-open-pr-pathspec-gh-");
    const successGh = await writeGhSuccessScript(
      ghScripts,
      "https://github.com/openclaw/clawpatch/pull/1000",
    );
    const previousGh = process.env["CLAWPATCH_GH"];
    try {
      process.env["CLAWPATCH_GH"] = successGh;
      const opened = (await openPrCommand(context, {
        patch: "pat_open_pr_pathspec",
        base: "main",
        branch: "clawpatch/pat_open_pr_pathspec",
      })) as { commit: string; pr: string };
      const committed = await runCommand(`git show --name-only --format= ${opened.commit}`, root);
      const cached = await runCommand("git diff --cached --name-only", root);

      expect(opened.pr).toBe("https://github.com/openclaw/clawpatch/pull/1000");
      expect(committed.stdout.trim().split("\n")).toEqual(["docs/foo bar.md"]);
      expect(cached.stdout.trim().split("\n")).toContain(".clawpatch/config.json");
    } finally {
      if (previousGh === undefined) {
        delete process.env["CLAWPATCH_GH"];
      } else {
        process.env["CLAWPATCH_GH"] = previousGh;
      }
    }
  });

  posixPathspecIt("opens PRs for literal names that look like git pathspec magic", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-literal-pathspec-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "open-pr-literal-pathspec" }));
    await writeFixture(root, "README.md", "base\n");
    await initGit(root);
    await checkCommand(root, "git add package.json README.md");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const origin = await fixtureRoot("clawpatch-open-pr-literal-pathspec-origin-");
    await checkCommand(root, `git init --bare -q ${origin}`);
    await checkCommand(root, `git remote add origin ${origin}`);
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    await writeFixture(root, ":(top)README.md", "literal\n");
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_literal_pathspec",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Add the reviewed literal pathspec-looking file.",
      filesChanged: [":(top)README.md"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: root,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: null,
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });
    const ghScripts = await fixtureRoot("clawpatch-open-pr-literal-pathspec-gh-");
    const successGh = await writeGhSuccessScript(
      ghScripts,
      "https://github.com/openclaw/clawpatch/pull/1002",
    );
    const previousGh = process.env["CLAWPATCH_GH"];
    try {
      process.env["CLAWPATCH_GH"] = successGh;
      const preview = (await openPrCommand(context, {
        patch: "pat_open_pr_literal_pathspec",
        base: "main",
        branch: "clawpatch/pat_open_pr_literal_pathspec",
        dryRun: true,
      })) as { commands: string[] };
      const opened = (await openPrCommand(context, {
        patch: "pat_open_pr_literal_pathspec",
        base: "main",
        branch: "clawpatch/pat_open_pr_literal_pathspec",
      })) as { commit: string; pr: string };
      const committed = await runCommand(`git show --name-status --format= ${opened.commit}`, root);
      const readme = await readFile(join(root, "README.md"), "utf8");

      expect(preview.commands).toContain("git add -- ':(literal):(top)README.md'");
      expect(opened.pr).toBe("https://github.com/openclaw/clawpatch/pull/1002");
      expect(committed.stdout.trim()).toBe("A\t:(top)README.md");
      expect(readme).toBe("base\n");
    } finally {
      if (previousGh === undefined) {
        delete process.env["CLAWPATCH_GH"];
      } else {
        process.env["CLAWPATCH_GH"] = previousGh;
      }
    }
  });

  it("opens PRs for staged renames when patch records only the destination", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-rename-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "open-pr-rename" }));
    await writeFixture(root, "docs/old.md", "TODO_BUG\n");
    await initGit(root);
    await checkCommand(root, "git add package.json docs");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const origin = await fixtureRoot("clawpatch-open-pr-rename-origin-");
    await checkCommand(root, `git init --bare -q ${origin}`);
    await checkCommand(root, `git remote add origin ${origin}`);
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    await checkCommand(root, "git mv docs/old.md docs/new.md");
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_rename",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Rename the reviewed file.",
      filesChanged: ["docs/new.md"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: root,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: null,
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });
    const ghScripts = await fixtureRoot("clawpatch-open-pr-rename-gh-");
    const successGh = await writeGhSuccessScript(
      ghScripts,
      "https://github.com/openclaw/clawpatch/pull/1001",
    );
    const previousGh = process.env["CLAWPATCH_GH"];
    try {
      process.env["CLAWPATCH_GH"] = successGh;
      const preview = (await openPrCommand(context, {
        patch: "pat_open_pr_rename",
        base: "main",
        branch: "clawpatch/pat_open_pr_rename",
        dryRun: true,
      })) as { commands: string[] };
      const opened = (await openPrCommand(context, {
        patch: "pat_open_pr_rename",
        base: "main",
        branch: "clawpatch/pat_open_pr_rename",
      })) as { commit: string; pr: string };
      const committed = await runCommand(`git show --name-status --format= ${opened.commit}`, root);

      expect(preview.commands).toContain("git add -- ':(literal)docs/new.md'");
      expect(preview.commands).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/git commit .*docs\/new\.md.*docs\/old\.md/u),
        ]),
      );
      expect(opened.pr).toBe("https://github.com/openclaw/clawpatch/pull/1001");
      expect(committed.stdout.trim()).toBe("R100\tdocs/old.md\tdocs/new.md");
    } finally {
      if (previousGh === undefined) {
        delete process.env["CLAWPATCH_GH"];
      } else {
        process.env["CLAWPATCH_GH"] = previousGh;
      }
    }
  });

  it("previews deletion patch PRs with update staging", async () => {
    const root = await fixtureRoot("clawpatch-open-pr-delete-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "open-pr-delete" }));
    await writeFixture(root, "docs/old.md", "TODO_BUG\n");
    await initGit(root);
    await checkCommand(root, "git add package.json docs");
    await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));
    await initCommand(context, {});
    await rm(join(root, "docs/old.md"));
    const now = new Date().toISOString();
    await writePatchAttempt(paths, {
      schemaVersion: 1,
      patchAttemptId: "pat_open_pr_delete",
      findingIds: [],
      featureIds: [],
      status: "applied",
      plan: "Delete the reviewed file.",
      filesChanged: ["docs/old.md"],
      commandsRun: [],
      testResults: [
        {
          command: "pnpm test",
          cwd: root,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
        },
      ],
      provider: null,
      git: {
        baseSha: (await runCommand("git rev-parse HEAD", root)).stdout.trim(),
        commitSha: null,
        branchName: null,
        prUrl: null,
      },
      createdAt: now,
      updatedAt: now,
    });

    const preview = (await openPrCommand(context, {
      patch: "pat_open_pr_delete",
      base: "main",
      branch: "clawpatch/pat_open_pr_delete",
      dryRun: true,
    })) as { commands: string[] };

    expect(preview.commands).toContain("git add -u -- ':(literal)docs/old.md'");
    expect(preview.commands).toEqual(
      expect.arrayContaining([expect.stringMatching(/git commit .*docs\/old\.md/u)]),
    );
    expect(preview.commands).not.toContain("git add -- docs/old.md");
  });

  it("persists failed patch attempts when provider fix throws", async () => {
    const root = await fixtureRoot("clawpatch-fix-fail-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as {
      next: string;
    };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    await expect(fixCommand(context, { finding, provider: "mock-fail" })).rejects.toThrow(
      "mock fix failure",
    );
    const paths = statePaths(join(root, ".clawpatch"));
    const patches = await readPatchAttempts(paths);
    const findings = await readFindings(paths);

    expect(patches[0]?.status).toBe("failed");
    expect(findings[0]?.linkedPatchAttemptIds).toContain(patches[0]?.patchAttemptId);
    delete process.env["CLAWPATCH_PROVIDER"];
  });
});
