import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { packageScripts, readPackageJson } from "../detect.js";
import { pathExists } from "../fs.js";
import { shellQuotePath } from "../shell.js";
import { isSafeDirectory, normalize, pathMatchesPrefix, shouldSkip } from "./shared.js";
import { taskGraphCommand, type WorkspaceTaskGraph } from "./task-graph.js";
import type { SeedFileRef } from "./types.js";

export type NodePackageJson = {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  bin?: unknown;
  exports?: unknown;
  main?: unknown;
  module?: unknown;
  types?: unknown;
  workspaces?: unknown;
};

export type NodeProjectTarget = {
  name: string;
};

export type NodeProjectInfo = {
  root: string;
  name: string;
  workspaceMember: boolean;
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
  const declaredPackageRoots = await discoverDeclaredPackageRoots(root, rootPackage);

  for (const packageRoot of await discoverPackageRoots(root, rootPackage)) {
    const packageJsonPath = packageRelativePath(packageRoot, "package.json");
    const packageJson = await readPackageJsonAt(root, packageJsonPath);
    if (packageJson === null) {
      continue;
    }
    byRoot.set(packageRoot, {
      root: packageRoot,
      name: packageDisplayName(packageRoot, packageJsonPath, packageJson),
      workspaceMember: packageRoot === "." || declaredPackageRoots.has(packageRoot),
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
      workspaceMember: projectRoot === "." || declaredPackageRoots.has(projectRoot),
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

  for (const projectRoot of await discoverGenericProjectRoots(root, rootPackage, byRoot)) {
    if (byRoot.has(projectRoot)) {
      continue;
    }
    byRoot.set(projectRoot, {
      root: projectRoot,
      name: basename(projectRoot),
      workspaceMember:
        declaredPackageRoots.has(projectRoot) || isConventionalProjectRoot(projectRoot),
      packageJsonPath: null,
      packageJson: null,
      projectJsonPath: null,
      sourceRoot: await genericProjectSourceRoot(root, projectRoot),
      projectType: projectRoot.startsWith("apps/") ? "application" : null,
      targets: {},
      packageManager: rootPackageManager,
      nxPackageManager: rootPackageManager,
    });
  }

  return [...byRoot.values()].toSorted((left, right) => left.root.localeCompare(right.root));
}

async function discoverDeclaredPackageRoots(
  root: string,
  rootPackage: NodePackageJson | null,
): Promise<Set<string>> {
  const patterns = await declaredWorkspacePatterns(root, rootPackage);
  const roots = await packageRootsForPatterns(root, patterns);
  return new Set(roots);
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
    "bun.lock",
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

export function projectTargetCommand(
  project: NodeProjectInfo,
  target: string,
  graph: WorkspaceTaskGraph,
): string | null | undefined {
  const graphCommand = taskGraphCommand(graph, project, target);
  if (graphCommand !== undefined) {
    return graphCommand;
  }
  if (project.targets[target] !== undefined) {
    return nxCommand(project.nxPackageManager, target, project.name);
  }
  if (project.packageJson !== null && packageScripts(project.packageJson)[target] !== undefined) {
    return scriptCommand(project.packageManager, project.root, target);
  }
  return undefined;
}

export function packageRelativePath(packageRoot: string, path: string): string {
  return packageRoot === "." ? normalize(path) : normalize(join(packageRoot, path));
}

export function scriptCommand(packageManager: string, packageRoot: string, script: string): string {
  const quotedRoot = shellQuotePath(packageRoot);
  const quotedScript = shellQuotePath(script);
  if (packageRoot === ".") {
    if (packageManager === "bun") {
      return `bun run ${quotedScript}`;
    }
    return packageManager === "npm"
      ? `npm run ${quotedScript}`
      : `${packageManager} ${quotedScript}`;
  }
  if (packageManager === "pnpm") {
    return `pnpm --dir ${quotedRoot} ${quotedScript}`;
  }
  if (packageManager === "yarn") {
    return `yarn --cwd ${quotedRoot} ${quotedScript}`;
  }
  if (packageManager === "bun") {
    return `bun --cwd ${quotedRoot} run ${quotedScript}`;
  }
  return `npm --prefix ${quotedRoot} run ${quotedScript}`;
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
    { path: packageRelativePath(project.root, "tsconfig.build.json"), reason: "package context" },
    { path: packageRelativePath(project.root, "vitest.config.ts"), reason: "test configuration" },
    { path: packageRelativePath(project.root, "vitest.config.mts"), reason: "test configuration" },
    { path: packageRelativePath(project.root, "vite.config.ts"), reason: "build configuration" },
    { path: packageRelativePath(project.root, "tsdown.config.ts"), reason: "build configuration" },
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
  for (const packageRoot of await packageRootsForPatterns(
    root,
    await workspacePatterns(root, rootPackage),
  )) {
    packageRoots.add(packageRoot);
  }
  return [...packageRoots].toSorted();
}

async function workspacePatterns(root: string, pkg: NodePackageJson | null): Promise<string[]> {
  const patterns = new Set(await declaredWorkspacePatterns(root, pkg));
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

async function declaredWorkspacePatterns(
  root: string,
  pkg: NodePackageJson | null,
): Promise<string[]> {
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
  return [...patterns];
}

async function packageRootsForPatterns(root: string, patterns: string[]): Promise<string[]> {
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .flatMap((pattern) => {
      const normalized = normalizeWorkspacePattern(pattern.slice(1));
      return normalized === null ? [] : [normalized];
    });
  const packageRoots = new Set<string>();
  for (const includePattern of patterns.filter((pattern) => !pattern.startsWith("!"))) {
    for (const packageRoot of await expandWorkspacePattern(root, includePattern)) {
      packageRoots.add(packageRoot);
    }
  }
  return [...packageRoots].filter((path) => !isExcludedWorkspace(path, excludes)).toSorted();
}

async function discoverGenericProjectRoots(
  root: string,
  rootPackage: NodePackageJson | null,
  existingProjects: Map<string, NodeProjectInfo>,
): Promise<string[]> {
  const patterns = await workspacePatterns(root, rootPackage);
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .flatMap((pattern) => {
      const normalized = normalizeWorkspacePattern(pattern.slice(1));
      return normalized === null ? [] : [normalized];
    });
  const projectRoots = new Set<string>();
  for (const includePattern of patterns.filter((pattern) => !pattern.startsWith("!"))) {
    for (const projectRoot of await expandGenericProjectPattern(root, includePattern)) {
      projectRoots.add(projectRoot);
    }
  }
  const roots: string[] = [];
  const acceptedRoots: string[] = [];
  for (const projectRoot of [...projectRoots].toSorted()) {
    if (
      projectRoot !== "." &&
      !isExcludedWorkspace(projectRoot, excludes) &&
      !(await pathExists(join(root, projectRoot, "package.json"))) &&
      !(await pathExists(join(root, projectRoot, "project.json"))) &&
      !isNestedUnderRoots(projectRoot, existingProjects.keys()) &&
      !isNestedUnderRoots(projectRoot, acceptedRoots) &&
      (await hasGenericProjectSignal(root, rootPackage, projectRoot))
    ) {
      roots.push(projectRoot);
      acceptedRoots.push(projectRoot);
    }
  }
  return roots;
}

function isNestedUnderRoots(projectRoot: string, roots: Iterable<string>): boolean {
  return [...roots].some(
    (existingRoot) =>
      existingRoot !== "." &&
      projectRoot !== existingRoot &&
      pathMatchesPrefix(projectRoot, existingRoot),
  );
}

async function expandGenericProjectPattern(root: string, pattern: string): Promise<string[]> {
  const normalized = normalizeWorkspacePattern(pattern);
  if (normalized === null || normalized === "." || normalized === "") {
    return [];
  }
  if (normalized.endsWith("/**") && !hasWorkspaceGlob(normalized.slice(0, -3))) {
    return discoverGenericProjectRootsUnder(root, normalized.slice(0, -3), 4);
  }
  const singleSegmentParent = normalized.endsWith("/*") ? normalized.slice(0, -2) : null;
  if (singleSegmentParent !== null && !hasWorkspaceGlob(singleSegmentParent)) {
    return (await safeDirectoryEntries(root, singleSegmentParent)).map(
      (entry) => `${singleSegmentParent}/${entry}`,
    );
  }
  if (hasWorkspaceGlob(normalized)) {
    return expandGenericProjectGlob(root, normalized);
  }
  return (await isSafeDirectory(root, join(root, normalized))) ? [normalized] : [];
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
    .replace(/\/$/u, "")
    .replace(/^\.\/+/u, "");
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

async function discoverGenericProjectRootsUnder(
  root: string,
  prefix: string,
  maxDepth: number,
): Promise<string[]> {
  const output: string[] = [];
  await discoverGenericProjectRootsInto(root, prefix, maxDepth, output);
  return output.filter((projectRoot) => projectRoot !== prefix).toSorted();
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

async function discoverGenericProjectRootsInto(
  root: string,
  prefix: string,
  remainingDepth: number,
  output: string[],
): Promise<void> {
  if (remainingDepth < 0 || shouldSkipProjectDir(prefix)) {
    return;
  }
  if (prefix.length > 0) {
    output.push(prefix);
  }
  for (const entry of await safeDirectoryEntries(root, prefix)) {
    await discoverGenericProjectRootsInto(root, `${prefix}/${entry}`, remainingDepth - 1, output);
  }
}

async function expandGenericProjectGlob(root: string, pattern: string): Promise<string[]> {
  const projects: string[] = [];
  const segments = pattern.split("/");

  async function visit(base: string, remaining: string[]): Promise<void> {
    const [segment, ...rest] = remaining;
    if (segment === undefined) {
      if (base.length > 0 && (await isSafeDirectory(root, join(root, base)))) {
        projects.push(base);
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
  return projects.toSorted();
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

async function hasGenericProjectSignal(
  root: string,
  rootPackage: NodePackageJson | null,
  projectRoot: string,
): Promise<boolean> {
  for (const file of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    if (await pathExists(join(root, packageRelativePath(projectRoot, file)))) {
      return true;
    }
  }
  if (await hasHoistedNextRouteSignal(root, rootPackage, projectRoot)) {
    return true;
  }
  for (const sourceRoot of genericProjectSourceRoots(projectRoot)) {
    const files = await sourceLikeFiles(root, sourceRoot);
    if (isGenericProjectSignal(sourceRoot, files)) {
      return true;
    }
  }
  return false;
}

async function genericProjectSourceRoot(root: string, projectRoot: string): Promise<string | null> {
  const src = packageRelativePath(projectRoot, "src");
  return (await pathExists(join(root, src))) ? src : null;
}

function genericProjectSourceRoots(projectRoot: string): string[] {
  return genericSourceRootNames.map((sourceRoot) => packageRelativePath(projectRoot, sourceRoot));
}

const genericSourceRootNames = ["src", "app", "pages", "lib", "server", "api"];

async function hasHoistedNextRouteSignal(
  root: string,
  rootPackage: NodePackageJson | null,
  projectRoot: string,
): Promise<boolean> {
  if (!hasNextDependency(rootPackage)) {
    return false;
  }
  for (const routeRoot of ["app", "src/app", "pages", "src/pages"]) {
    const prefix = packageRelativePath(projectRoot, routeRoot);
    const files = await sourceLikeFilesAtDepth(root, prefix, 12);
    if (files.some((file) => isGenericNextRouteFile(projectRoot, file))) {
      return true;
    }
  }
  return false;
}

function hasNextDependency(pkg: NodePackageJson | null): boolean {
  return (
    dependencyFieldHas(pkg?.dependencies, "next") ||
    dependencyFieldHas(pkg?.devDependencies, "next")
  );
}

function isGenericNextRouteFile(projectRoot: string, file: string): boolean {
  const relativeFile = projectRoot === "." ? file : pathRelativeToPrefix(file, projectRoot);
  return (
    /^src\/app\/.+\/(?:page|route)\.[cm]?[jt]sx?$/iu.test(relativeFile) ||
    /^app\/.+\/(?:page|route)\.[cm]?[jt]sx?$/iu.test(relativeFile) ||
    (/^(?:src\/)?pages\/api\/.+\.[cm]?[jt]sx?$/iu.test(relativeFile) &&
      !/^(?:src\/)?pages\/_(?:app|document|error)\.[cm]?[jt]sx?$/iu.test(relativeFile))
  );
}

function isGenericProjectSignal(sourceRoot: string, files: string[]): boolean {
  if (files.length === 0) {
    return false;
  }
  const sourceRootName = sourceRoot.split("/").at(-1);
  if (sourceRootName === "src") {
    return true;
  }
  return files.some((file) => {
    const relativeFile = pathRelativeToPrefix(file, sourceRoot);
    const [firstSegment, ...rest] = relativeFile.split("/");
    if (isNestedSourceSignal(sourceRootName, firstSegment)) {
      return true;
    }
    return (
      firstSegment === undefined ||
      rest.length === 0 ||
      !genericSourceRootNames.includes(firstSegment)
    );
  });
}

function isNestedSourceSignal(
  sourceRootName: string | undefined,
  firstSegment: string | undefined,
): boolean {
  return (
    firstSegment === "api" &&
    (sourceRootName === "app" || sourceRootName === "pages" || sourceRootName === "server")
  );
}

function pathRelativeToPrefix(path: string, prefix: string): string {
  return path === prefix ? "" : path.slice(prefix.length + 1);
}

async function sourceLikeFiles(root: string, sourceRoot: string): Promise<string[]> {
  return sourceLikeFilesAtDepth(root, sourceRoot, 4);
}

async function sourceLikeFilesAtDepth(
  root: string,
  sourceRoot: string,
  maxDepth: number,
): Promise<string[]> {
  const files: string[] = [];
  await sourceLikeFilesInto(root, sourceRoot, maxDepth, files);
  return files;
}

async function sourceLikeFilesInto(
  root: string,
  prefix: string,
  remainingDepth: number,
  output: string[],
): Promise<void> {
  if (remainingDepth < 0 || shouldSkipProjectDir(prefix)) {
    return;
  }
  for (const entry of await safeDirectoryEntries(root, prefix)) {
    await sourceLikeFilesInto(root, packageRelativePath(prefix, entry), remainingDepth - 1, output);
  }
  for (const file of await safeFileEntries(root, prefix)) {
    const path = packageRelativePath(prefix, file);
    if (isReviewableGenericSourceFile(path)) {
      output.push(path);
    }
  }
}

function isReviewableGenericSourceFile(path: string): boolean {
  return (
    /\.(?:[cm]?[jt]sx?)$/iu.test(path) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(path) &&
    !/\.d\.[cm]?ts$/iu.test(path) &&
    !/(^|\/)(?:__fixtures__|fixtures|testdata)(\/|$)/iu.test(path) &&
    !/(^|\/)(?:generated|__generated__)(\/|$)/iu.test(path) &&
    !/(^|\/)[^/]*(?:generated|\.gen)\.[^.]+$/iu.test(path)
  );
}

async function safeFileEntries(root: string, prefix: string): Promise<string[]> {
  const dir = join(root, prefix);
  if (!(await isSafeDirectory(root, dir))) {
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
    if (childInfo.isFile() && !childInfo.isSymbolicLink()) {
      output.push(entry);
    }
  }
  return output.toSorted();
}

function isConventionalProjectRoot(projectRoot: string): boolean {
  return /^(?:apps|packages|frontend|client|web|ui|extensions|plugins)(?:\/|$)/u.test(projectRoot);
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
  if ((await pathExists(join(root, "bun.lock"))) || (await pathExists(join(root, "bun.lockb")))) {
    return "bun";
  }
  return "npm";
}

export function nxCommand(packageManager: string, target: string, projectName: string): string {
  // `projectName` is repo-derived (Nx project.json / package.json name / dir
  // basename), so it must be shell-quoted before reaching the `shell: true`
  // runner. `target` comes from the validationTaskNames allowlist.
  const quotedName = shellQuotePath(projectName);
  if (packageManager === "npm") {
    return `npx nx ${target} ${quotedName}`;
  }
  if (packageManager === "bun") {
    return `bunx nx ${target} ${quotedName}`;
  }
  return `${packageManager} nx ${target} ${quotedName}`;
}
