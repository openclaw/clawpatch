import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { runCommandArgs } from "./exec.js";
import { ClawpatchError } from "./errors.js";
import { parseGitStatus } from "./git-status.js";

export type GitInfo = {
  root: string | null;
  remoteUrl: string | null;
  defaultBranch: string | null;
  currentBranch: string | null;
  headSha: string | null;
  dirty: boolean;
};

export async function discoverGit(cwd: string): Promise<GitInfo> {
  const root = await gitLine(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) {
    return {
      root: null,
      remoteUrl: null,
      defaultBranch: null,
      currentBranch: null,
      headSha: null,
      dirty: false,
    };
  }
  const [remoteUrl, currentBranch, headSha, statusOutput, originHead] = await Promise.all([
    gitLine(root, ["config", "--get", "remote.origin.url"]),
    gitLine(root, ["branch", "--show-current"]),
    gitLine(root, ["rev-parse", "HEAD"]),
    gitText(root, ["status", "--porcelain=v1", "-z"]),
    gitLine(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]),
  ]);
  return {
    root,
    remoteUrl,
    defaultBranch: originHead?.replace("refs/remotes/origin/", "") ?? null,
    currentBranch,
    headSha,
    dirty: statusOutput.trim().length > 0,
  };
}

export async function findProjectRoot(cwd: string, explicitRoot?: string): Promise<string> {
  if (explicitRoot !== undefined) {
    const root = resolve(cwd, explicitRoot);
    const info = await stat(root).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new ClawpatchError(`root not found: ${explicitRoot}`, 2, "invalid-root");
    }
    return root;
  }
  const git = await discoverGit(cwd);
  return git.root ?? cwd;
}

export function projectNameFromRoot(root: string, remoteUrl: string | null): string {
  if (remoteUrl !== null) {
    const withoutGit = remoteUrl.replace(/\.git$/u, "");
    const last = withoutGit.split(/[/:]/u).at(-1);
    if (last !== undefined && last.length > 0) {
      return last;
    }
  }
  return basename(root);
}

export async function changedFilesSince(root: string, ref: string): Promise<Set<string>> {
  validateGitRef(ref);
  const result = await runCommandArgs(
    "git",
    // Rename summaries omit the old path, which can still own mapped features.
    ["diff", "--no-renames", "--name-only", "--relative", "-z", `${ref}...HEAD`, "--"],
    root,
    undefined,
    { trimOutput: false },
  );
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      `git diff --since ${ref} failed: ${result.stderr || result.stdout}`,
      2,
      "git-failure",
    );
  }
  return new Set(result.stdout.split("\0").filter((path) => path.length > 0));
}

export async function dirtyFiles(root: string): Promise<Set<string>> {
  const gitRoot = await gitLine(root, ["rev-parse", "--show-toplevel"]);
  const [resolvedRoot, resolvedGitRoot] = await Promise.all([
    realpath(root).catch(() => root),
    gitRoot === null ? Promise.resolve(root) : realpath(gitRoot).catch(() => gitRoot),
  ]);
  const result = await runCommandArgs(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    root,
    undefined,
    { trimOutput: false },
  );
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      `git status failed: ${result.stderr || result.stdout}`,
      2,
      "git-failure",
    );
  }
  const paths = new Set<string>();
  for (const change of parseGitStatus(result.stdout)) {
    for (const path of change.paths) {
      addDirtyPath(paths, resolvedRoot, resolvedGitRoot, path);
    }
  }
  return paths;
}

function addDirtyPath(paths: Set<string>, root: string, gitRoot: string, path: string): void {
  const relativePath = relative(root, join(gitRoot, path));
  const normalized =
    process.platform === "win32" ? relativePath.replace(/\\/gu, "/") : relativePath;
  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    isAbsolute(normalized)
  ) {
    return;
  }
  paths.add(normalized);
}

async function gitLine(cwd: string, args: string[]): Promise<string | null> {
  const result = await runCommandArgs("git", args, cwd);
  if (result.exitCode !== 0) {
    return null;
  }
  const line = result.stdout.trim();
  return line.length > 0 ? line : null;
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const result = await runCommandArgs("git", args, cwd, undefined, { trimOutput: false });
  return result.exitCode === 0 ? result.stdout : "";
}

function validateGitRef(ref: string): void {
  if (ref.length === 0 || ref.startsWith("-") || !/^[A-Za-z0-9_./~^@-]+$/u.test(ref)) {
    throw new ClawpatchError(`invalid git ref: ${ref}`, 2, "invalid-input");
  }
}
