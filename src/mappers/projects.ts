import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { packageScripts, readPackageJson } from "../detect.js";
import { pathExists } from "../fs.js";
import { isSafeDirectory, normalize, pathMatchesPrefix, shouldSkip } from "./shared.js";
import type { SeedFileRef } from "./types.js";

export type NodePackageJson = {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  bin?: unknown;
  workspaces?: unknown;
};

export type NodeProjectTarget = {
  name: string;
};

export type NodeProjectInfo = {
  root: string;
  name: string;
  packageJsonPath: string | null;
  packageJson: NodePackageJson | null;
  projectJsonPath: string | null;
  sourceRoot: string | null;
  projectType: string | null;
  targets: Record<string, NodeProjectTarget>;
  packageManager: string;
  nxPackageManager: string;
};

type CandidateContextFile = {
  path: string | null;
  reason: string;
};

export async function discoverNodeProjects(root: string): Promise<NodeProjectInfo[]> {
  const rootPackage = await readPackageJson(root);
  const rootPackageManager = await detectNodePackageManager(root);
  const byRoot = new Map<string, NodeProjectInfo>();

  for (const packageRoot of await discoverPackageRoots(root, rootPackage)) {
    const packageJsonPath = packageRelativePath(packageRoot, "package.json");
    const packageJson = await readPackageJsonAt(root, packageJsonPath);
    if (packageJson === null) {
      continue;
    }
    byRoot.set(packageRoot, {
      root: packageRoot,
      name: packageDisplayName(packageRoot, packageJsonPath, packageJson),
      packageJsonPath,
      packageJson,
      projectJsonPath: null,
      sourceRoot: null,
      projectType: null,
      targets: {},
      packageManager: await nodePackageManagerForPackage(root, packageRoot, rootPackageManager),
      nxPackageManager: rootPackageManager,
    });
  }

  for (const projectJsonPath of await discoverNxProjectJsonPaths(root)) {
    const nxProject = await readNxProjectJson(root, projectJsonPath);
    if (nxProject === null) {
      continue;
    }
    const projectRoot = dirname(projectJsonPath);
    const packageJsonPath = packageRelativePath(projectRoot, "package.json");
    const packageJson =
      byRoot.get(projectRoot)?.packageJson ?? (await readPackageJsonAt(root, packageJsonPath));
    const previous = byRoot.get(projectRoot);
    byRoot.set(projectRoot, {
      root: projectRoot,
      name: nxProjectName({
        projectRoot,
        packageJsonPath,
        packageJson,
        previousName: previous?.name,
        nxName: nxProject.name,
      }),
      packageJsonPath: packageJson === null ? null : packageJsonPath,
      packageJson,
      projectJsonPath,
      sourceRoot: nxProject.sourceRoot,
      projectType: nxProject.projectType,
      targets: nxProject.targets,
      packageManager: await nodePackageManagerForPackage(root, projectRoot, rootPackageManager),
      nxPackageManager: rootPackageManager,
    });
  }

  return [...byRoot.values()].toSorted((left, right) => left.root.localeCompare(right.root));
}

async function nodePackageManagerForPackage(
  root: string,
  packageRoot: string,
  rootPackageManager: string,
): Promise<string> {
  if (packageRoot === ".") {
    return rootPackageManager;
  }
  const packageDir = join(root, packageRoot);
  for (const lockfile of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "bun.lockb",
    "package-lock.json",
  ]) {
    if (await pathExists(join(packageDir, lockfile))) {
      return detectNodePackageManager(packageDir);
    }
  }
  return rootPackageManager;
}

export function projectTags(project: NodeProjectInfo): string[] {
  const tags = [`project:${project.name}`, `project-root:${project.root}`];
  if (project.projectType !== null) {
    tags.push(`project-type:${project.projectType}`);
  }
  return tags;
}

export function projectContextFiles(
  root: string,
  project: NodeProjectInfo,
): Promise<SeedFileRef[]> {
  return existingProjectContextFiles(root, project);
}

export function projectTargetCommand(project: NodeProjectInfo, target: string): string | null {
  if (project.targets[target] !== undefined) {
    return nxCommand(project.nxPackageManager, target, project.name);
  }
  if (project.packageJson !== null && packageScripts(project.packageJson)[target] !== undefined) {
    return scriptCommand(project.packageManager, project.root, target);
  }
  return null;
}

export function packageRelativePath(packageRoot: string, path: string): string {
  return packageRoot === "." ? normalize(path) : normalize(join(packageRoot, path));
}

export function scriptCommand(packageManager: string, packageRoot: string, script: string): string {
  if (packageRoot === ".") {
    if (packageManager === "bun") {
      return `bun run ${script}`;
    }
    return packageManager === "npm" ? `npm run ${script}` : `${packageManager} ${script}`;
  }
  if (packageManager === "pnpm") {
    return `pnpm --dir ${packageRoot} ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn --cwd ${packageRoot} ${script}`;
  }
  if (packageManager === "bun") {
    return `bun --cwd ${packageRoot} run ${script}`;
  }
  return `npm --prefix ${packageRoot} run ${script}`;
}

export function projectDisplayName(info: NodeProjectInfo): string {
  return info.name;
}

export function dependencyFieldHas(field: unknown, name: string): boolean {
  return typeof field === "object" && field !== null && Object.hasOwn(field, name);
}

async function existingProjectContextFiles(
  root: string,
  project: NodeProjectInfo,
): Promise<SeedFileRef[]> {
  const candidates: CandidateContextFile[] = [
    { path: project.packageJsonPath, reason: "package manifest" },
    { path: project.projectJsonPath, reason: "project context" },
    { path: packageRelativePath(project.root, "README.md"), reason: "package context" },
    { path: packageRelativePath(project.root, "AGENTS.md"), reason: "package context" },
    { path: packageRelativePath(project.root, "tsconfig.json"), reason: "package context" },
    { path: packageRelativePath(project.root, "next.config.js"), reason: "project context" },
    { path: packageRelativePath(project.root, "next.config.mjs"), reason: "project context" },
    { path: packageRelativePath(project.root, "next.config.ts"), reason: "project context" },
  ];
  const refs: SeedFileRef[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const candidatePath = candidate.path;
    if (candidatePath === null) {
      continue;
    }
    if (seen.has(candidatePath) || !(await pathExists(join(root, candidatePath)))) {
      continue;
    }
    seen.add(candidatePath);
    refs.push({ path: candidatePath, reason: candidate.reason });
  }
  return refs;
}

function nxProjectName(options: {
  projectRoot: string;
  packageJsonPath: string;
  packageJson: NodePackageJson | null;
  previousName: string | undefined;
  nxName: string | null;
}): string {
  if (options.nxName !== null) {
    return options.nxName;
  }
  if (options.previousName !== undefined) {
    return options.previousName;
  }
  if (options.packageJson !== null) {
    return packageDisplayName(options.projectRoot, options.packageJsonPath, options.packageJson);
  }
  if (options.projectRoot === ".") {
    return "root";
  }
  return basename(options.projectRoot);
}

async function discoverPackageRoots(
  root: string,
  rootPackage: NodePackageJson | null,
): Promise<string[]> {
  const packageRoots = new Set<string>();
  if (rootPackage !== null) {
    packageRoots.add(".");
  }
  const patterns = await workspacePatterns(root, rootPackage);
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .flatMap((pattern) => {
      const normalized = normalizeWorkspacePattern(pattern.slice(1));
      return normalized === null ? [] : [normalized];
    });
  for (const includePattern of patterns.filter((pattern) => !pattern.startsWith("!"))) {
    for (const packageRoot of await expandWorkspacePattern(root, includePattern)) {
      packageRoots.add(packageRoot);
    }
  }
  return [...packageRoots].filter((path) => !isExcludedWorkspace(path, excludes)).toSorted();
}

async function workspacePatterns(root: string, pkg: NodePackageJson | null): Promise<string[]> {
  const patterns = new Set<string>();
  if (pkg !== null) {
    for (const pattern of packageWorkspacePatterns(pkg)) {
      patterns.add(pattern);
    }
  }
  if (await pathExists(join(root, "pnpm-workspace.yaml"))) {
    for (const pattern of parsePnpmWorkspace(
      await readFile(join(root, "pnpm-workspace.yaml"), "utf8"),
    )) {
      patterns.add(pattern);
    }
  }
  for (const fallback of [
    "frontend",
    "client",
    "web",
    "ui",
    "packages/*",
    "apps/*",
    "extensions/*",
    "plugins/*",
  ]) {
    if (await pathExists(join(root, fallback.replace(/\/\*$/u, "")))) {
      patterns.add(fallback);
    }
  }
  return [...patterns];
}

function packageWorkspacePatterns(pkg: NodePackageJson): string[] {
  const workspaces = pkg.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === "string");
  }
  if (
    typeof workspaces === "object" &&
    workspaces !== null &&
    Array.isArray((workspaces as { packages?: unknown }).packages)
  ) {
    return (workspaces as { packages: unknown[] }).packages.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return [];
}

function parsePnpmWorkspace(source: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/#.*/u, "");
    if (/^\S/u.test(line)) {
      inPackages = /^packages\s*:/u.test(line);
    }
    if (!inPackages) {
      continue;
    }
    const match = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      patterns.push(match[1]);
    }
  }
  return patterns;
}

async function expandWorkspacePattern(root: string, pattern: string): Promise<string[]> {
  const normalized = normalizeWorkspacePattern(pattern);
  if (normalized === null) {
    return [];
  }
  if (normalized === "." || normalized === "") {
    return ["."];
  }
  if (normalized.endsWith("/**") && !hasWorkspaceGlob(normalized.slice(0, -3))) {
    return discoverPackageRootsUnder(root, normalized.slice(0, -3), 4);
  }
  const singleSegmentParent = normalized.endsWith("/*") ? normalized.slice(0, -2) : null;
  if (singleSegmentParent !== null && !hasWorkspaceGlob(singleSegmentParent)) {
    const entries = await safeDirectoryEntries(root, singleSegmentParent);
    const packageRoots: string[] = [];
    for (const entry of entries) {
      const candidate = `${singleSegmentParent}/${entry}`;
      if (await pathExists(join(root, candidate, "package.json"))) {
        packageRoots.push(candidate);
      }
    }
    return packageRoots;
  }
  if (hasWorkspaceGlob(normalized)) {
    return expandWorkspaceGlob(root, normalized);
  }
  return (await isSafeDirectory(root, join(root, normalized))) &&
    (await pathExists(join(root, normalized, "package.json")))
    ? [normalized]
    : [];
}

function normalizeWorkspacePattern(pattern: string): string | null {
  const normalized = normalize(pattern)
    .replace(/\/package\.json$/u, "")
    .replace(/\/$/u, "");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return null;
  }
  return normalized;
}

function isExcludedWorkspace(packageRoot: string, excludes: string[]): boolean {
  return excludes.some((pattern) => workspacePatternMatches(pattern, packageRoot));
}

function workspacePatternMatches(pattern: string, packageRoot: string): boolean {
  if (pattern === packageRoot) {
    return true;
  }
  if (hasWorkspaceGlob(pattern)) {
    return workspaceGlobMatches(pattern, packageRoot);
  }
  if (pattern.endsWith("/**")) {
    return pathMatchesPrefix(packageRoot, pattern.slice(0, -3));
  }
  if (pattern.endsWith("/*")) {
    const parent = pattern.slice(0, -2);
    if (!pathMatchesPrefix(packageRoot, parent)) {
      return false;
    }
    return packageRoot.slice(parent.length + 1).split("/").length === 1;
  }
  return false;
}

function workspaceGlobMatches(pattern: string, packageRoot: string): boolean {
  return globSegmentsMatch(pattern.split("/"), packageRoot.split("/"));
}

function globSegmentsMatch(pattern: string[], candidate: string[]): boolean {
  const [segment, ...remainingPattern] = pattern;
  if (segment === undefined) {
    return candidate.length === 0;
  }
  if (segment === "**") {
    return (
      globSegmentsMatch(remainingPattern, candidate) ||
      (candidate.length > 0 && globSegmentsMatch(pattern, candidate.slice(1)))
    );
  }
  const [candidateSegment, ...remainingCandidate] = candidate;
  if (candidateSegment === undefined || !globSegmentRegExp(segment).test(candidateSegment)) {
    return false;
  }
  return globSegmentsMatch(remainingPattern, remainingCandidate);
}

async function expandWorkspaceGlob(root: string, pattern: string): Promise<string[]> {
  const packages: string[] = [];
  const segments = pattern.split("/");

  async function visit(base: string, remaining: string[]): Promise<void> {
    const [segment, ...rest] = remaining;
    if (segment === undefined) {
      if (
        base.length > 0 &&
        (await isSafeDirectory(root, join(root, base))) &&
        (await pathExists(join(root, base, "package.json")))
      ) {
        packages.push(base);
      }
      return;
    }

    if (!hasWorkspaceGlob(segment)) {
      await visit(base.length === 0 ? segment : `${base}/${segment}`, rest);
      return;
    }

    if (segment === "**") {
      await visit(base, rest);
      for (const entry of await safeDirectoryEntries(root, base)) {
        await visit(base.length === 0 ? entry : `${base}/${entry}`, remaining);
      }
      return;
    }

    const matcher = globSegmentRegExp(segment);
    for (const entry of await safeDirectoryEntries(root, base)) {
      if (matcher.test(entry)) {
        await visit(base.length === 0 ? entry : `${base}/${entry}`, rest);
      }
    }
  }

  await visit("", segments);
  return packages.toSorted();
}

function hasWorkspaceGlob(pattern: string): boolean {
  return /[*?]/u.test(pattern);
}

function globSegmentRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")}$`, "u");
}

async function discoverPackageRootsUnder(
  root: string,
  prefix: string,
  maxDepth: number,
): Promise<string[]> {
  const output: string[] = [];
  await discoverPackageRootsInto(root, prefix, maxDepth, output);
  return output.toSorted();
}

async function discoverPackageRootsInto(
  root: string,
  prefix: string,
  remainingDepth: number,
  output: string[],
): Promise<void> {
  if (remainingDepth < 0 || shouldSkipProjectDir(prefix)) {
    return;
  }
  if (await pathExists(join(root, prefix, "package.json"))) {
    output.push(prefix);
  }
  for (const entry of await safeDirectoryEntries(root, prefix)) {
    await discoverPackageRootsInto(root, `${prefix}/${entry}`, remainingDepth - 1, output);
  }
}

async function discoverNxProjectJsonPaths(root: string): Promise<string[]> {
  const output: string[] = [];
  await discoverNxProjectJsonPathsInto(root, "", 5, output);
  return output.toSorted();
}

async function discoverNxProjectJsonPathsInto(
  root: string,
  prefix: string,
  remainingDepth: number,
  output: string[],
): Promise<void> {
  if (remainingDepth < 0 || shouldSkipProjectDir(prefix)) {
    return;
  }
  const projectJsonPath = packageRelativePath(prefix === "" ? "." : prefix, "project.json");
  if (projectJsonPath !== "project.json" && (await pathExists(join(root, projectJsonPath)))) {
    output.push(projectJsonPath);
  }
  for (const entry of await safeDirectoryEntries(root, prefix)) {
    await discoverNxProjectJsonPathsInto(
      root,
      prefix.length === 0 ? entry : `${prefix}/${entry}`,
      remainingDepth - 1,
      output,
    );
  }
}

function shouldSkipProjectDir(path: string): boolean {
  return shouldSkip(path) || /(^|\/)(\.next|\.turbo|\.vercel)(\/|$)/u.test(path);
}

async function safeDirectoryEntries(root: string, prefix: string): Promise<string[]> {
  const dir = join(root, prefix);
  if (!(await isSafeDirectory(root, dir))) {
    return [];
  }
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)]);
  if (!pathMatchesPrefix(normalize(realDir), normalize(realRoot))) {
    return [];
  }
  const entries = await readdir(dir);
  const output: string[] = [];
  for (const entry of entries) {
    const rel = normalize(join(prefix, entry));
    if (shouldSkipProjectDir(rel)) {
      continue;
    }
    const childInfo = await lstat(join(dir, entry));
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      output.push(entry);
    }
  }
  return output.toSorted();
}

async function readPackageJsonAt(root: string, path: string): Promise<NodePackageJson | null> {
  if (!(await pathExists(join(root, path)))) {
    return null;
  }
  const parsed: unknown = JSON.parse(await readFile(join(root, path), "utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as NodePackageJson) : null;
}

type NxProjectJson = {
  name: string | null;
  sourceRoot: string | null;
  projectType: string | null;
  targets: Record<string, NodeProjectTarget>;
};

async function readNxProjectJson(root: string, path: string): Promise<NxProjectJson | null> {
  if (!(await pathExists(join(root, path)))) {
    return null;
  }
  const parsed: unknown = JSON.parse(await readFile(join(root, path), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as {
    name?: unknown;
    sourceRoot?: unknown;
    projectType?: unknown;
    targets?: unknown;
  };
  return {
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : null,
    sourceRoot:
      typeof record.sourceRoot === "string" && record.sourceRoot.length > 0
        ? normalize(record.sourceRoot)
        : null,
    projectType:
      typeof record.projectType === "string" && record.projectType.length > 0
        ? record.projectType
        : null,
    targets: nxTargets(record.targets),
  };
}

function nxTargets(targets: unknown): Record<string, NodeProjectTarget> {
  if (typeof targets !== "object" || targets === null) {
    return {};
  }
  const output: Record<string, NodeProjectTarget> = {};
  for (const name of Object.keys(targets).toSorted()) {
    output[name] = { name };
  }
  return output;
}

function packageDisplayName(
  packageRoot: string,
  packageJsonPath: string,
  packageJson: NodePackageJson,
): string {
  if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
    return packageJson.name;
  }
  return packageRoot === "." ? basename(dirname(join(packageJsonPath))) : basename(packageRoot);
}

async function detectNodePackageManager(root: string): Promise<string> {
  if (
    (await pathExists(join(root, "pnpm-lock.yaml"))) ||
    (await pathExists(join(root, "pnpm-workspace.yaml")))
  ) {
    return "pnpm";
  }
  if (await pathExists(join(root, "yarn.lock"))) {
    return "yarn";
  }
  if (await pathExists(join(root, "bun.lockb"))) {
    return "bun";
  }
  return "npm";
}

function nxCommand(packageManager: string, target: string, projectName: string): string {
  if (packageManager === "npm") {
    return `npx nx ${target} ${projectName}`;
  }
  if (packageManager === "bun") {
    return `bunx nx ${target} ${projectName}`;
  }
  return `${packageManager} nx ${target} ${projectName}`;
}
