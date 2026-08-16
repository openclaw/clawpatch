import { chmod } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initCommand, makeContext, openPrCommand } from "./app.js";
import { runCommand } from "./exec.js";
import { ghPrCreateTimeoutMs, gitPushTimeoutMs } from "./open-pr.js";
import { statePaths, writePatchAttempt } from "./state.js";
import { fixtureRoot, testOptions, writeFixture } from "./test-helpers.js";
import type { PatchAttempt } from "./types.js";

const HANG_TEST_TIMEOUT_MS = 4_000;
const SHORT_TIMEOUT_MS = 80;

describe("open-pr command timeouts", () => {
  const previousEnv = {
    CLAWPATCH_GH: process.env["CLAWPATCH_GH"],
    CLAWPATCH_GIT_PUSH_TIMEOUT_MS: process.env["CLAWPATCH_GIT_PUSH_TIMEOUT_MS"],
    CLAWPATCH_GH_PR_CREATE_TIMEOUT_MS: process.env["CLAWPATCH_GH_PR_CREATE_TIMEOUT_MS"],
    PATH: process.env["PATH"],
  };

  afterEach(() => {
    restoreEnv("CLAWPATCH_GH", previousEnv.CLAWPATCH_GH);
    restoreEnv("CLAWPATCH_GIT_PUSH_TIMEOUT_MS", previousEnv.CLAWPATCH_GIT_PUSH_TIMEOUT_MS);
    restoreEnv("CLAWPATCH_GH_PR_CREATE_TIMEOUT_MS", previousEnv.CLAWPATCH_GH_PR_CREATE_TIMEOUT_MS);
    restoreEnv("PATH", previousEnv.PATH);
  });

  it("defaults git push to 10m and gh pr create to 5m", () => {
    delete process.env["CLAWPATCH_GIT_PUSH_TIMEOUT_MS"];
    delete process.env["CLAWPATCH_GH_PR_CREATE_TIMEOUT_MS"];

    expect(gitPushTimeoutMs()).toBe(600_000);
    expect(ghPrCreateTimeoutMs()).toBe(300_000);
  });

  it("accepts positive timeout overrides and rejects invalid values", () => {
    process.env["CLAWPATCH_GIT_PUSH_TIMEOUT_MS"] = "1234";
    process.env["CLAWPATCH_GH_PR_CREATE_TIMEOUT_MS"] = "5678";
    expect(gitPushTimeoutMs()).toBe(1_234);
    expect(ghPrCreateTimeoutMs()).toBe(5_678);

    process.env["CLAWPATCH_GIT_PUSH_TIMEOUT_MS"] = "invalid";
    process.env["CLAWPATCH_GH_PR_CREATE_TIMEOUT_MS"] = "0";
    expect(gitPushTimeoutMs()).toBe(600_000);
    expect(ghPrCreateTimeoutMs()).toBe(300_000);
  });

  it(
    "times out a hung git push instead of blocking open-pr",
    { timeout: HANG_TEST_TIMEOUT_MS },
    async () => {
      const setup = await recordedPatchFixture("clawpatch-open-pr-push-timeout-");
      process.env["PATH"] =
        `${await writeGitPushHangWrapper(setup.scriptsRoot)}${delimiter}${process.env["PATH"] ?? ""}`;
      process.env["CLAWPATCH_GIT_PUSH_TIMEOUT_MS"] = String(SHORT_TIMEOUT_MS);
      process.env["CLAWPATCH_GH"] = await writeHangScript(setup.scriptsRoot, "hang-gh-unused");

      const started = Date.now();
      await expect(
        openPrCommand(setup.context, {
          patch: setup.patch.patchAttemptId,
          base: "main",
          branch: setup.patch.git.branchName ?? "clawpatch/timeout",
        }),
      ).rejects.toMatchObject({
        code: "git-failure",
        message: expect.stringContaining(`timed out after ${SHORT_TIMEOUT_MS}ms`),
      });
      expect(Date.now() - started).toBeLessThan(1_500);
    },
  );

  it(
    "times out a hung gh pr create instead of blocking open-pr",
    { timeout: HANG_TEST_TIMEOUT_MS },
    async () => {
      const setup = await recordedPatchFixture("clawpatch-open-pr-gh-timeout-");
      process.env["CLAWPATCH_GH_PR_CREATE_TIMEOUT_MS"] = String(SHORT_TIMEOUT_MS);
      process.env["CLAWPATCH_GH"] = await writeHangScript(setup.scriptsRoot, "hang-gh");

      const started = Date.now();
      await expect(
        openPrCommand(setup.context, {
          patch: setup.patch.patchAttemptId,
          base: "main",
          branch: setup.patch.git.branchName ?? "clawpatch/timeout",
        }),
      ).rejects.toMatchObject({
        code: "github-failure",
        message: expect.stringContaining(`timed out after ${SHORT_TIMEOUT_MS}ms`),
      });
      expect(Date.now() - started).toBeLessThan(1_500);
    },
  );
});

async function recordedPatchFixture(prefix: string): Promise<{
  root: string;
  scriptsRoot: string;
  context: Awaited<ReturnType<typeof makeContext>>;
  patch: PatchAttempt;
}> {
  const root = await fixtureRoot(prefix);
  await writeFixture(root, "package.json", JSON.stringify({ name: "open-pr-timeout" }));
  await writeFixture(root, "src/index.ts", "export const value = 'fixed';\n");
  await initGit(root);
  await checkCommand(root, "git add package.json src/index.ts");
  await checkCommand(root, 'git -c commit.gpgsign=false commit -q -m "base"');
  const origin = await fixtureRoot(`${prefix}origin-`);
  await checkCommand(root, `git init --bare -q ${origin}`);
  await checkCommand(root, `git remote add origin ${origin}`);
  const commitSha = (await runCommand("git rev-parse HEAD", root)).stdout.trim();
  const context = await makeContext(testOptions(root));
  const paths = statePaths(join(root, ".clawpatch"));
  await initCommand(context, {});
  const now = new Date().toISOString();
  const patch: PatchAttempt = {
    schemaVersion: 1,
    patchAttemptId: "pat_open_pr_timeout",
    findingIds: [],
    featureIds: [],
    status: "validated",
    plan: "Time out hung remotes.",
    filesChanged: ["src/index.ts"],
    commandsRun: [],
    testResults: [],
    provider: null,
    git: {
      baseSha: commitSha,
      commitSha,
      branchName: "clawpatch/pat_open_pr_timeout",
      prUrl: null,
    },
    createdAt: now,
    updatedAt: now,
  };
  await writePatchAttempt(paths, patch);
  return {
    root,
    scriptsRoot: await fixtureRoot(`${prefix}scripts-`),
    context,
    patch,
  };
}

async function initGit(root: string): Promise<void> {
  await checkCommand(root, "git init -q");
  await checkCommand(root, "git config user.email test@example.com");
  await checkCommand(root, "git config user.name Test");
  await checkCommand(root, "git config commit.gpgsign false");
}

async function checkCommand(root: string, command: string): Promise<void> {
  const result = await runCommand(command, root);
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

async function writeHangScript(root: string, name: string): Promise<string> {
  if (process.platform === "win32") {
    const path = `${name}.cmd`;
    await writeFixture(root, path, "@echo off\r\n:loop\r\ntimeout /t 30 >nul\r\ngoto loop\r\n");
    return join(root, path);
  }
  const path = `${name}.sh`;
  const fullPath = join(root, path);
  await writeFixture(root, path, "#!/bin/sh\nwhile true; do sleep 30; done\n");
  await chmod(fullPath, 0o755);
  return fullPath;
}

async function writeGitPushHangWrapper(root: string): Promise<string> {
  const realGit = (await runCommand("command -v git", root)).stdout.trim();
  if (realGit.length === 0) {
    throw new Error("git executable not found");
  }
  const binDir = join(root, "bin");
  const wrapper = join(binDir, process.platform === "win32" ? "git.cmd" : "git");
  if (process.platform === "win32") {
    await writeFixture(
      root,
      "bin/git.cmd",
      `@echo off\r\nif /I "%~1"=="push" goto hang\r\n"${realGit}" %*\r\nexit /b %ERRORLEVEL%\r\n:hang\r\n:loop\r\ntimeout /t 30 >nul\r\ngoto loop\r\n`,
    );
    return binDir;
  }
  await writeFixture(
    root,
    "bin/git",
    `#!/bin/sh\nif [ "$1" = "push" ]; then\n  while true; do sleep 30; done\nfi\nexec ${shellArg(realGit)} "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  return binDir;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
