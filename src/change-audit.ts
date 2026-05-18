import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { runCommand } from "./exec.js";

export async function hasSourceDirtyWorktree(root: string, stateDir: string): Promise<boolean> {
  const paths = await sourceChangedPaths(root, stateDir);
  return paths === null || paths.size > 0;
}

export async function sourceChangedSnapshots(
  root: string,
  stateDir: string,
): Promise<Map<string, string> | null> {
  const paths =
    (await sourceChangedPaths(root, stateDir)) ?? (await sourceSnapshotPaths(root, stateDir));
  const snapshots = new Map<string, string>();
  for (const path of [...paths].toSorted()) {
    snapshots.set(path, await pathFingerprint(root, path));
  }
  return snapshots;
}

export function changedPathsBetweenSnapshots(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .toSorted();
}

async function sourceChangedPaths(root: string, stateDir: string): Promise<Set<string> | null> {
  const result = await runCommand("git status --porcelain=v1 -z -uall", root, undefined, {
    trimOutput: false,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  const relativeStateDir = normalizePath(relative(root, stateDir));
  return new Set(
    parsePorcelainPaths(result.stdout).filter(
      (path) => path.length > 0 && !isStatePath(path, relativeStateDir),
    ),
  );
}

async function pathFingerprint(root: string, path: string): Promise<string> {
  const full = resolve(root, path);
  const info = await lstat(full).catch(() => null);
  if (info === null) {
    return "missing";
  }
  if (info.isSymbolicLink()) {
    return `symlink:${await readlink(full).catch(() => "unreadable")}`;
  }
  if (!info.isFile()) {
    return `non-file:${info.size}:${Math.trunc(info.mtimeMs)}`;
  }
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(full)) {
      hash.update(chunk);
    }
  } catch {
    return "unreadable";
  }
  return `file:${info.mode}:${info.size}:${hash.digest("hex")}`;
}

function parsePorcelainPaths(output: string): string[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    const path = normalizePath(field.slice(3));
    paths.push(path);
    if (/[RC]/u.test(status)) {
      index += 1;
    }
  }
  return paths;
}

function isStatePath(path: string, relativeStateDir: string): boolean {
  if (relativeStateDir === "" || relativeStateDir.startsWith("..")) {
    return false;
  }
  return path === relativeStateDir || path.startsWith(`${relativeStateDir}/`);
}

async function sourceSnapshotPaths(root: string, stateDir: string): Promise<Set<string>> {
  const relativeStateDir = normalizePath(relative(root, stateDir));
  const paths = new Set<string>();
  await collectSnapshotPaths(root, root, relativeStateDir, paths);
  return paths;
}

async function collectSnapshotPaths(
  root: string,
  dir: string,
  relativeStateDir: string,
  paths: Set<string>,
): Promise<void> {
  const entries = await readdir(dir).catch(() => []);
  for (const entry of entries) {
    const full = resolve(dir, entry);
    const path = normalizePath(relative(root, full));
    if (shouldSkipSnapshotPath(path, relativeStateDir)) {
      continue;
    }
    const info = await lstat(full).catch(() => null);
    if (info === null || info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      await collectSnapshotPaths(root, full, relativeStateDir, paths);
    } else if (info.isFile()) {
      paths.add(path);
    }
  }
}

function shouldSkipSnapshotPath(path: string, relativeStateDir: string): boolean {
  return (
    isStatePath(path, relativeStateDir) ||
    /(^|\/)(node_modules|dist|build|coverage|\.build|\.git|\.turbo|\.next|\.vercel|\.venv(?:-[^/]+)?|venv|Pods|Carthage|SourcePackages|DerivedData|__pycache__)(\/|$)/u.test(
      path,
    ) ||
    path === "target" ||
    path.startsWith("target/")
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/$/u, "");
}
