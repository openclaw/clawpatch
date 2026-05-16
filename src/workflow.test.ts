import { describe, expect, it, vi } from "vitest";
import { access, mkdir, readFile, rm, symlink, unlink } from "node:fs/promises";
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
import { packageVersion, parseArgs } from "./cli.js";
import { loadConfig } from "./config.js";
import { runCommand } from "./exec.js";
import {
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
    expect(parseArgs(["review", "--limit", "4", "--jobs", "3"]).flags).toMatchObject({
      limit: "4",
      jobs: "3",
    });
    expect(parseArgs(["report", "--status", "open", "--severity", "high"]).flags).toMatchObject({
      status: "open",
      severity: "high",
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
    await writeFeature(paths, {
      ...feature!,
      status: "claimed",
      lock: {
        lockedByRunId: "run",
        lockedAt: new Date().toISOString(),
        hostname: "test",
        pid: 1,
      },
    });
    await cleanLocksCommand(context);
    const cleaned = (await readFeatures(paths))[0];

    expect(cleaned?.status).toBe("pending");
    expect(cleaned?.lock).toBeNull();
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
