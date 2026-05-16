import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { runCommand } from "./exec.js";
import { ClawpatchError } from "./errors.js";

export type GitInfo = {
  root: string | null;
  remoteUrl: string | null;
  defaultBranch: string | null;
  currentBranch: string | null;
  headSha: string | null;
  dirty: boolean;
};

export async function discoverGit(cwd: string): Promise<GitInfo> {
  const root = await gitLine(cwd, "git rev-parse --show-toplevel");
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
    gitLine(root, "git config --get remote.origin.url"),
    gitLine(root, "git branch --show-current"),
    gitLine(root, "git rev-parse HEAD"),
    gitText(root, "git status --porcelain"),
    gitLine(root, "git symbolic-ref refs/remotes/origin/HEAD"),
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
    const info = await stat(explicitRoot).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new ClawpatchError(`root not found: ${explicitRoot}`, 2, "invalid-root");
    }
    return explicitRoot;
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
  const result = await runCommand(
    `git diff --name-only --relative ${shellQuoteRef(ref)}...HEAD`,
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
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

async function gitLine(cwd: string, command: string): Promise<string | null> {
  const result = await runCommand(command, cwd);
  if (result.exitCode !== 0) {
    return null;
  }
  const line = result.stdout.trim();
  return line.length > 0 ? line : null;
}

async function gitText(cwd: string, command: string): Promise<string> {
  const result = await runCommand(command, cwd);
  return result.exitCode === 0 ? result.stdout : "";
}

function shellQuoteRef(ref: string): string {
  if (!/^[A-Za-z0-9_./~^@-]+$/u.test(ref)) {
    throw new ClawpatchError(`invalid git ref: ${ref}`, 2, "invalid-input");
  }
  return ref;
}
