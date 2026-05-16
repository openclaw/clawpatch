import { describe, expect, it, vi } from "vitest";
import { access, mkdir, open, readFile, readdir, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  fixCommand,
  cleanLocksCommand,
  initCommand,
  makeContext,
  mapCommand,
  nextCommand,
  reportCommand,
  revalidateCommand,
  reviewCommand,
  showCommand,
  statusCommand,
  triageCommand,
} from "./app.js";
import { main as cliMain, packageVersion, parseArgs } from "./cli.js";
import { loadConfig } from "./config.js";
import { runCommand } from "./exec.js";
import { changedFilesSince } from "./git.js";
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
} from "./state.js";
import { buildReviewPrompt } from "./prompt.js";
import { fixtureRoot, testOptions, writeFixture } from "./test-helpers.js";
import { findingRecordSchema } from "./types.js";
import type { FeatureRecord } from "./types.js";

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
    expect(parseArgs(["revie", "--help"])).toMatchObject({ command: "revie", help: true });
    expect(() => parseArgs(["show"])).toThrow("missing --finding");
    expect(() => parseArgs(["triage", "--status", "fixed"])).toThrow("missing --finding");
    expect(() => parseArgs(["revalidate"])).toThrow("missing --finding or --all");
    expect(parseArgs(["revalidate", "--all"]).flags).toMatchObject({ all: true });
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
    expect(parseArgs(["map", "--dry-run"]).flags).toMatchObject({ dryRun: true });
    expect(parseArgs(["review", "--dry-run"]).flags).toMatchObject({ dryRun: true });
    expect(parseArgs(["fix", "--finding", "f", "--dry-run"]).flags).toMatchObject({
      dryRun: true,
      finding: "f",
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
    expect(parseArgs(["revalidate", "--since", "origin/main"]).flags).toMatchObject({
      since: "origin/main",
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

    await expect(makeContext(testOptions(root))).rejects.toMatchObject({ exitCode: 2 });
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
    expect(report).toMatchObject({ markdown: expect.stringContaining("src/index.ts:1") });
    expect(report).toMatchObject({ markdown: expect.stringContaining("test analysis:") });
    expect(jsonReport).toMatchObject({
      findings: 1,
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
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("selects review features whose owned files overlap the diff range", async () => {
    const root = await sinceFixture("clawpatch-since-owned-");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "src/two.ts", "export const two = 'changed';\n");
    await commitAll(root, "change two");
    const paths = statePaths(join(root, ".clawpatch"));
    const features = await readFeatures(paths);
    const reviewed = await reviewCommand(context, { since: "base", limit: "20", dryRun: true });

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
    const reviewed = await reviewCommand(context, { since: "base", limit: "20", dryRun: true });
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
    const reviewed = await reviewCommand(context, { since: "HEAD", dryRun: true });

    expect(reviewed).toMatchObject({ next: "no features touched by diff" });
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
    const reviewed = await reviewCommand(context, { since: "base", limit: "2", dryRun: true });

    expect(reviewed).toMatchObject({
      dryRun: true,
      featureIds: expectedFeatureIds(features, new Set(["src/two.ts", "src/three.ts"]), true).slice(
        0,
        2,
      ),
    });
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
      await writeFinding(paths, { ...finding, reasoning: markers[index] ?? "" });
    }

    let progress = "";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      progress += String(chunk);
      return true;
    });
    const result = await revalidateCommand(context, { all: true, status: "open", limit: "4" });
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
      revalidateCommand(context, { finding: finding!.findingId, provider: "mock-fail" }),
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
      JSON.stringify({ name: "parallel", bin: { one: "src/one.ts", two: "src/two.ts" } }),
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
      JSON.stringify({ name: "lock-write-fail", bin: { lock: "src/index.ts" } }),
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

  it("does not recurse through symlinked mapper directories", async () => {
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
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
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
      JSON.stringify({ name: "file-lock-status", bin: { clean: "src/index.ts" } }),
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

    expect(await statusCommand(context)).toMatchObject({ activeLocks: 1, lockFiles: 1 });
  });

  it("cleans interrupted review locks through the CLI entrypoint", async () => {
    const root = await fixtureRoot("clawpatch-clean-locks-cli-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "clean-locks-cli", bin: { clean: "src/index.ts" } }),
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

    expect(JSON.parse(output.stdout)).toMatchObject({ cleared: 1, lockFilesCleared: 1 });
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
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
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
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
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
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const paths = statePaths(join(root, ".clawpatch"));
    const feature = (await readFeatures(paths))[0];
    const featureCommand = 'node -e "process.exit(7)"';
    await writeFeature(paths, {
      ...feature!,
      tests: [{ path: "src/index.test.ts", command: featureCommand }],
    });
    await expect(fixCommand(context, { finding })).rejects.toMatchObject({ exitCode: 6 });
    const [patches, updatedFinding] = await Promise.all([
      readPatchAttempts(paths),
      readFinding(paths, finding),
    ]);

    expect(patches[0]?.status).toBe("failed");
    expect(patches[0]?.commandsRun).toHaveLength(1);
    expect(patches[0]?.commandsRun[0]).toMatchObject({ command: featureCommand, exitCode: 7 });
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
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
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
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    await expect(fixCommand(context, { finding })).rejects.toMatchObject({
      code: "dirty-worktree",
    });

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
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    await expect(fixCommand(context, { finding })).rejects.toMatchObject({ exitCode: 6 });
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

  it("does not include escaped feature paths in prompts", async () => {
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
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
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
