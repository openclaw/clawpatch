import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { loadProjectState, type AppContext } from "./app-context.js";
import { ClawpatchError, assertDefined } from "./errors.js";
import { runCommandArgs } from "./exec.js";
import { nowIso } from "./fs.js";
import { discoverGit } from "./git.js";
import { parseGitStatus } from "./git-status.js";
import { readFindings, readPatchAttempts, statePaths, writePatchAttempt } from "./state.js";
import type { CommandResult, FindingRecord, PatchAttempt } from "./types.js";

export async function openPrCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const patchId = assertDefined(stringFlag(flags, "patch"), "missing --patch");
  const patches = await readPatchAttempts(loaded.paths);
  const patch = assertDefined(
    patches.find((candidate) => candidate.patchAttemptId === patchId),
    `patch attempt not found: ${patchId}`,
  );
  const force = flags["force"] === true;
  validatePrPatch(patch, force);
  const git = await discoverGit(loaded.root);
  if (git.root === null) {
    throw new ClawpatchError("open-pr requires a git repository", 2, "not-git-repository");
  }
  const base = stringFlag(flags, "base") ?? git.defaultBranch;
  const branch = prBranchName(patch, stringFlag(flags, "branch"), git.currentBranch, base);
  if (
    flags["dryRun"] !== true &&
    patch.git.prUrl !== null &&
    patch.git.commitSha !== null &&
    patch.git.branchName !== null
  ) {
    return {
      patchAttempt: patch.patchAttemptId,
      branch: patch.git.branchName,
      base,
      commit: patch.git.commitSha,
      pr: patch.git.prUrl,
      next: patch.git.prUrl,
    };
  }
  const findings = await readFindings(loaded.paths);
  const linkedFindings = findings.filter((finding) => patch.findingIds.includes(finding.findingId));
  const title = prTitle(stringFlag(flags, "title"), linkedFindings, patch);
  const body = renderPatchPrBody(patch, linkedFindings);
  const gitFiles = await gitRelativePatchFiles(git.root, loaded.root, patch.filesChanged);
  const draft = flags["draft"] === true;
  const dryRunStagePlan =
    flags["dryRun"] === true && patch.git.commitSha === null
      ? await patchStagePlan(
          git.root,
          await assertPatchWorktree(patch, git.root, loaded.paths.stateDir, gitFiles, force),
        )
      : null;
  const branchExists =
    flags["dryRun"] === true && patch.git.commitSha === null
      ? await localBranchExists(git.root, branch)
      : false;
  const commands = plannedPrCommands(
    patch,
    branch,
    base,
    title,
    gitFiles,
    draft,
    branchExists,
    dryRunStagePlan,
  );
  if (flags["dryRun"] === true) {
    return {
      dryRun: true,
      patchAttempt: patch.patchAttemptId,
      branch,
      base,
      title,
      body,
      commands,
      commandsPreview: commands.join("\n"),
    };
  }

  const patchWorktree = await assertPatchWorktree(
    patch,
    git.root,
    loaded.paths.stateDir,
    gitFiles,
    force,
  );
  let commitSha = patch.git.commitSha;
  const hadRecordedCommit = commitSha !== null;
  if (commitSha === null) {
    const patchBaseSha = assertDefined(patch.git.baseSha, "missing patch base");
    const targetBranchExists = await localBranchExists(git.root, branch);
    if (targetBranchExists) {
      await assertRefAtPatchBase(git.root, branch, patch);
    }
    if (git.currentBranch !== branch) {
      const switchArgs = targetBranchExists
        ? ["switch", branch]
        : ["switch", "-c", branch, patchBaseSha];
      await checkedRun("git switch", runCommandArgs("git", switchArgs, git.root));
    }
    await assertRefAtPatchBase(git.root, "HEAD", patch);
    const stagePlan = await patchStagePlan(git.root, patchWorktree);
    if (stagePlan.addFiles.length > 0) {
      await checkedRun(
        "git add",
        runCommandArgs("git", ["add", "--", ...stagePlan.addFiles.map(gitPathspec)], git.root),
      );
    }
    if (stagePlan.updateFiles.length > 0) {
      await checkedRun(
        "git add -u",
        runCommandArgs(
          "git",
          ["add", "-u", "--", ...stagePlan.updateFiles.map(gitPathspec)],
          git.root,
        ),
      );
    }
    await checkedRun(
      "git commit",
      runCommandArgs(
        "git",
        ["commit", "-m", title, "--", ...stagePlan.commitFiles.map(gitPathspec)],
        git.root,
      ),
    );
    const commit = await checkedRun(
      "git rev-parse",
      runCommandArgs("git", ["rev-parse", "HEAD"], git.root),
    );
    commitSha = commit.stdout.trim();
    await writePatchPrGitState(loaded.paths, patch, {
      commitSha,
      branchName: branch,
      prUrl: patch.git.prUrl,
    });
  }
  commitSha = assertDefined(commitSha, "missing patch commit");
  const pushArgs = hadRecordedCommit
    ? ["push", "origin", `${commitSha}:refs/heads/${branch}`]
    : ["push", "-u", "origin", branch];
  await checkedRun("git push", runCommandArgs("git", pushArgs, git.root));
  const ghArgs = prCreateArgs(base, branch, title, draft);
  const gh = await checkedRun("gh pr create", runCommandArgs(githubCli(), ghArgs, git.root, body));
  const prUrl = firstUrl(gh.stdout) ?? gh.stdout.trim();
  await writePatchPrGitState(loaded.paths, patch, { commitSha, branchName: branch, prUrl });
  return {
    patchAttempt: patch.patchAttemptId,
    branch,
    base,
    commit: commitSha,
    pr: prUrl,
    next: prUrl.length > 0 ? prUrl : "inspect GitHub CLI output",
  };
}

async function writePatchPrGitState(
  paths: ReturnType<typeof statePaths>,
  patch: PatchAttempt,
  git: { commitSha: string; branchName: string; prUrl: string | null },
): Promise<void> {
  await writePatchAttempt(paths, {
    ...patch,
    git: {
      ...patch.git,
      commitSha: git.commitSha,
      branchName: git.branchName,
      prUrl: git.prUrl,
    },
    updatedAt: nowIso(),
  });
}

function validatePrPatch(patch: PatchAttempt, force: boolean): void {
  if (patch.filesChanged.length === 0) {
    throw new ClawpatchError(
      `patch has no changed files: ${patch.patchAttemptId}`,
      2,
      "invalid-input",
    );
  }
  if (!["applied", "validated"].includes(patch.status) && !force) {
    throw new ClawpatchError(
      `patch is not ready for PR: ${patch.patchAttemptId} (${patch.status})`,
      2,
      "invalid-input",
    );
  }
  const failed = patch.testResults.filter((result) => result.exitCode !== 0);
  if (failed.length > 0 && !force) {
    throw new ClawpatchError(
      `patch validation failed; use --force to open a PR anyway: ${failed[0]?.command ?? "unknown"}`,
      6,
      "validation-failed",
    );
  }
}

function prBranchName(
  patch: PatchAttempt,
  explicit: string | undefined,
  currentBranch: string | null,
  base: string | null,
): string {
  if (explicit !== undefined) {
    return explicit;
  }
  if (base === null) {
    return patch.git.branchName?.startsWith("clawpatch/") === true
      ? patch.git.branchName
      : `clawpatch/${patch.patchAttemptId}`;
  }
  if (
    patch.git.branchName !== null &&
    patch.git.branchName !== base &&
    patch.git.branchName !== "main" &&
    patch.git.branchName !== "master"
  ) {
    return patch.git.branchName;
  }
  if (
    base !== null &&
    currentBranch !== null &&
    currentBranch !== base &&
    currentBranch !== "main" &&
    currentBranch !== "master"
  ) {
    return currentBranch;
  }
  return `clawpatch/${patch.patchAttemptId}`;
}

function prTitle(
  explicit: string | undefined,
  findings: FindingRecord[],
  patch: PatchAttempt,
): string {
  if (explicit !== undefined) {
    return explicit;
  }
  const title = findings[0]?.title ?? patch.plan.split("\n")[0] ?? patch.patchAttemptId;
  return `fix: ${title}`.slice(0, 120);
}

function renderPatchPrBody(patch: PatchAttempt, findings: FindingRecord[]): string {
  const lines = [
    "## Summary",
    "",
    `- patch attempt: \`${patch.patchAttemptId}\``,
    `- status: \`${patch.status}\``,
    `- files changed: ${patch.filesChanged.length}`,
    "",
    "## Findings",
    "",
  ];
  if (findings.length === 0) {
    lines.push("- none linked");
  } else {
    for (const finding of findings) {
      lines.push(`- \`${finding.findingId}\`: ${finding.title} (${finding.severity})`);
    }
  }
  lines.push("", "## Changed Files", "");
  for (const file of patch.filesChanged) {
    lines.push(`- \`${file}\``);
  }
  lines.push("", "## Validation", "");
  const validation = patch.testResults.length > 0 ? patch.testResults : patch.commandsRun;
  if (validation.length === 0) {
    lines.push("- none recorded");
  } else {
    for (const result of validation) {
      lines.push(`- \`${result.command}\` => ${result.exitCode ?? "unknown"}`);
    }
  }
  lines.push("", "## Plan", "", patch.plan, "");
  return `${lines.join("\n")}\n`;
}

async function gitRelativePatchFiles(
  gitRoot: string,
  projectRoot: string,
  files: string[],
): Promise<string[]> {
  const projectPrefix = await gitRelativePathPrefix(gitRoot, projectRoot);
  if (projectPrefix === ".." || projectPrefix.startsWith("../")) {
    throw new ClawpatchError(
      `project root is outside git repository: ${projectRoot}`,
      2,
      "invalid-root",
    );
  }
  const scopedPrefix = isUsableRelativePrefix(projectPrefix) ? projectPrefix : "";
  return files.map((file) => {
    const relativeFile = normalizePath(file);
    if (
      relativeFile.startsWith("../") ||
      relativeFile === ".." ||
      relativeFile.split("/").includes("..") ||
      resolve(relativeFile) === relativeFile ||
      relativeFile.length === 0
    ) {
      throw new ClawpatchError(`patch file escapes git repository: ${file}`, 2, "invalid-input");
    }
    return scopedPrefix.length === 0 ? relativeFile : `${scopedPrefix}/${relativeFile}`;
  });
}

function plannedPrCommands(
  patch: PatchAttempt,
  branch: string,
  base: string | null,
  title: string,
  gitFiles: string[],
  draft: boolean,
  branchExists: boolean,
  stagePlan: PatchStagePlan | null,
): string[] {
  const commands: string[] = [];
  if (patch.git.commitSha === null) {
    const patchBaseSha = assertDefined(patch.git.baseSha, "missing patch base");
    const commitFiles = stagePlan?.commitFiles ?? gitFiles;
    const addFiles = stagePlan?.addFiles ?? gitFiles;
    const updateFiles = stagePlan?.updateFiles ?? [];
    commands.push(
      branchExists
        ? `git switch ${shellArg(branch)}`
        : `git switch -c ${shellArg(branch)} ${shellArg(patchBaseSha)}`,
    );
    if (addFiles.length > 0) {
      commands.push(`git add -- ${shellPathspecArgs(addFiles)}`);
    }
    if (updateFiles.length > 0) {
      commands.push(`git add -u -- ${shellPathspecArgs(updateFiles)}`);
    }
    commands.push(`git commit -m ${shellArg(title)} -- ${shellPathspecArgs(commitFiles)}`);
  }
  commands.push(
    patch.git.commitSha === null
      ? `git push -u origin ${shellArg(branch)}`
      : `git push origin ${shellArg(`${patch.git.commitSha}:refs/heads/${branch}`)}`,
  );
  commands.push(`gh ${prCreateArgs(base, branch, title, draft).map(shellArg).join(" ")}`);
  return commands;
}

function prCreateArgs(
  base: string | null,
  branch: string,
  title: string,
  draft: boolean,
): string[] {
  const args = ["pr", "create", "--head", branch, "--title", title, "--body-file", "-"];
  if (base !== null) {
    args.splice(2, 0, "--base", base);
  }
  if (draft) {
    args.push("--draft");
  }
  return args;
}

async function assertPatchWorktree(
  patch: PatchAttempt,
  gitRoot: string,
  stateDir: string,
  gitFiles: string[],
  force: boolean,
): Promise<{ commitFiles: string[]; stagedOnlyFiles: string[] }> {
  if (patch.git.commitSha !== null) {
    return { commitFiles: gitFiles, stagedOnlyFiles: [] };
  }
  const status = await checkedRun(
    "git status",
    runCommandArgs(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      gitRoot,
      undefined,
      {
        trimOutput: false,
      },
    ),
  );
  const statusChanges = parseGitStatus(status.stdout);
  const dirty = uniqueStrings(statusChanges.flatMap((change) => change.paths));
  const statePrefix = await gitRelativePathPrefix(gitRoot, stateDir);
  const sourceDirty = dirty.filter((file) => !isStatePath(file, statePrefix));
  if (sourceDirty.length === 0) {
    throw new ClawpatchError("no uncommitted patch changes to commit", 2, "invalid-input");
  }
  const expected = new Set(gitFiles);
  const commitFiles = new Set(gitFiles);
  const stagedOnlyFiles = new Set<string>();
  for (const change of statusChanges) {
    if (change.secondaryPath === undefined) {
      continue;
    }
    if (expected.has(change.primaryPath) || expected.has(change.secondaryPath)) {
      commitFiles.add(change.primaryPath);
      commitFiles.add(change.secondaryPath);
      stagedOnlyFiles.add(change.secondaryPath);
    }
  }
  const extra = sourceDirty.filter((file) => !commitFiles.has(file));
  if (extra.length > 0 && !force) {
    throw new ClawpatchError(
      `dirty worktree has files outside patch attempt: ${extra.join(", ")}`,
      3,
      "dirty-worktree",
    );
  }
  const missing = gitFiles.filter((file) => !sourceDirty.includes(file));
  if (missing.length > 0 && !force) {
    throw new ClawpatchError(
      `patch files are not dirty in the worktree: ${missing.join(", ")}`,
      2,
      "invalid-input",
    );
  }
  return { commitFiles: [...commitFiles], stagedOnlyFiles: [...stagedOnlyFiles] };
}

type PatchStagePlan = {
  commitFiles: string[];
  addFiles: string[];
  updateFiles: string[];
};

async function patchStagePlan(
  root: string,
  patchWorktree: { commitFiles: string[]; stagedOnlyFiles: string[] },
): Promise<PatchStagePlan> {
  const stagedOnlyFiles = new Set(patchWorktree.stagedOnlyFiles);
  const stageableFiles = patchWorktree.commitFiles.filter((file) => !stagedOnlyFiles.has(file));
  const addFiles = await existingGitFiles(root, stageableFiles);
  const updateFiles = stageableFiles.filter((file) => !addFiles.includes(file));
  return { commitFiles: patchWorktree.commitFiles, addFiles, updateFiles };
}

function isStatePath(file: string, statePrefix: string): boolean {
  return statePrefix.length > 0 && (file === statePrefix || file.startsWith(`${statePrefix}/`));
}

async function gitRelativePathPrefix(gitRoot: string, path: string): Promise<string> {
  const direct = normalizePath(relative(gitRoot, path));
  if (isUsableRelativePrefix(direct)) {
    return direct;
  }
  const [realGitRoot, realPath] = await Promise.all([
    realpath(gitRoot).catch(() => gitRoot),
    realpath(path).catch(() => path),
  ]);
  const resolved = normalizePath(relative(realGitRoot, realPath));
  if (resolved === "" || isUsableRelativePrefix(resolved)) {
    return resolved;
  }
  const normalizedGitRoot = normalizeDarwinPrivateVar(realGitRoot);
  const normalizedPath = normalizeDarwinPrivateVar(realPath);
  if (normalizedPath === normalizedGitRoot) {
    return "";
  }
  if (normalizedPath.startsWith(`${normalizedGitRoot}/`)) {
    return normalizedPath.slice(normalizedGitRoot.length + 1);
  }
  return direct;
}

function isUsableRelativePrefix(path: string): boolean {
  return path.length > 0 && path !== "." && path !== ".." && !path.startsWith("../");
}

async function checkedRun(
  label: string,
  resultPromise: Promise<CommandResult>,
): Promise<CommandResult> {
  const result = await resultPromise;
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      `${label} failed: ${result.stderr || result.stdout}`,
      label.startsWith("gh") ? 7 : 1,
      label.startsWith("gh") ? "github-failure" : "git-failure",
    );
  }
  return result;
}

function githubCli(): string {
  return process.env["CLAWPATCH_GH"] ?? "gh";
}

async function localBranchExists(gitRoot: string, branch: string): Promise<boolean> {
  const result = await runCommandArgs(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    gitRoot,
  );
  return result.exitCode === 0;
}

async function assertRefAtPatchBase(
  gitRoot: string,
  ref: string,
  patch: PatchAttempt,
): Promise<void> {
  const head = await checkedRun(
    "git rev-parse",
    runCommandArgs("git", ["rev-parse", ref], gitRoot),
  );
  const sha = head.stdout.trim();
  if (sha !== patch.git.baseSha) {
    const message = [
      `patch attempt ${patch.patchAttemptId} was recorded from ${patch.git.baseSha},`,
      `but ${ref} is ${sha}`,
    ].join(" ");
    throw new ClawpatchError(message, 2, "invalid-input");
  }
}

function firstUrl(output: string): string | null {
  return /https?:\/\/\S+/u.exec(output)?.[0] ?? null;
}

function gitPathspec(path: string): string {
  return `:(literal)${path}`;
}

function shellPathspecArgs(files: string[]): string {
  return files.map((file) => shellArg(gitPathspec(file))).join(" ");
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "'\\''")}'`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function existingGitFiles(root: string, files: string[]): Promise<string[]> {
  const existing = await Promise.all(
    files.map(async (file) =>
      (await lstat(resolve(root, file)).catch(() => null)) === null ? null : file,
    ),
  );
  return existing.filter((file): file is string => file !== null);
}

function normalizeDarwinPrivateVar(path: string): string {
  return normalizePath(path).replace(/^\/private\/var\//u, "/var/");
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}
