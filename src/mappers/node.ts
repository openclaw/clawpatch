import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { packageBins, packageScripts, readPackageJson } from "../detect.js";
import { pathExists } from "../fs.js";
import {
  normalize,
  isSafeDirectory,
  packageKind,
  packageTrustBoundaries,
  pathMatchesPrefix,
  shouldSkip,
  walk,
} from "./shared.js";
import { FeatureSeed, SeedFileRef, SeedTestRef } from "./types.js";

type NodePackageJson = {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  bin?: unknown;
  workspaces?: unknown;
};

type PackageInfo = {
  root: string;
  packageJsonPath: string;
  packageJson: NodePackageJson;
};

type SourceGroup = {
  label: string;
  files: string[];
};

const sourceDirectories = ["src", "lib", "app", "pages", "scripts"] as const;
const testDirectories = ["test", "tests", "__tests__"] as const;
const sourceGroupMaxOwnedFiles = 12;
const sourceGroupMaxTests = 8;

export async function nodeSeeds(root: string): Promise<FeatureSeed[]> {
  const rootPackage = await readPackageJson(root);
  const packages = await discoverPackages(root, rootPackage);
  const packageManager = await detectNodePackageManager(root);
  const seeds: FeatureSeed[] = [];

  for (const info of packages) {
    seeds.push(...(await packageSeeds(root, info, packageManager)));
    seeds.push(...(await sourceGroupSeeds(root, info, packageManager)));
  }

  return seeds;
}

async function packageSeeds(
  root: string,
  info: PackageInfo,
  packageManager: string,
): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  const packageName = packageDisplayName(info);
  const packageTags = ["node", "package"];
  if (info.root !== ".") {
    packageTags.push("workspace");
  }

  const manifestSeed: FeatureSeed = {
    title: `Node package ${packageName}`,
    summary: `Node package manifest at ${info.packageJsonPath}.`,
    kind: packageKind(`${packageName} ${info.root}`),
    source: "node-package",
    confidence: "medium",
    entryPath: info.packageJsonPath,
    symbol: packageName,
    route: null,
    command: null,
    ownedFiles: [{ path: info.packageJsonPath, reason: "package manifest" }],
    contextFiles: await packageContextFiles(root, info),
    tags: packageTags,
    trustBoundaries: packageTrustBoundaries(`${packageName} ${info.root}`),
    skipNearbyTests: true,
  };

  for (const [command, path] of Object.entries(packageBins(info.packageJson))) {
    const entryPath = await resolvePackageBinEntry(root, info.root, path);
    seeds.push({
      title: `CLI command ${command}`,
      summary:
        entryPath === packageRelativePath(info.root, normalizePackagePath(path))
          ? `Package bin '${command}' at ${path}.`
          : `Package bin '${command}' at ${path}, source ${entryPath}.`,
      kind: "cli-command",
      source: "package-json-bin",
      confidence: "high",
      entryPath,
      symbol: null,
      route: null,
      command,
      tags: ["node", "cli"],
      trustBoundaries: ["user-input", "filesystem", "process-exec"],
      ...(packageScripts(info.packageJson)["test"]
        ? { testCommand: scriptCommand(packageManager, info.root, "test") }
        : {}),
    });
  }

  for (const [script, command] of Object.entries(packageScripts(info.packageJson))) {
    if (!["start", "build", "test", "lint", "typecheck", "format"].includes(script)) {
      continue;
    }
    seeds.push({
      title:
        info.root === "."
          ? `Package script ${script}`
          : `Package script ${script} (${packageName})`,
      summary:
        info.root === "."
          ? `Package script '${script}': ${command}`
          : `Package script '${script}' in ${info.packageJsonPath}: ${command}`,
      kind: script === "test" ? "test-suite" : "release",
      source: "package-json-script",
      confidence: "medium",
      entryPath: info.packageJsonPath,
      symbol: script,
      route: null,
      command: script,
      tags: ["node", "package-script"],
      trustBoundaries: script === "test" ? [] : ["process-exec", "filesystem"],
      skipNearbyTests: true,
    });
  }

  seeds.push(manifestSeed);
  return seeds;
}

async function sourceGroupSeeds(
  root: string,
  info: PackageInfo,
  packageManager: string,
): Promise<FeatureSeed[]> {
  const packageName = packageDisplayName(info);
  const testCommand = packageScripts(info.packageJson)["test"]
    ? scriptCommand(packageManager, info.root, "test")
    : null;
  const testFiles = await packageTestFiles(root, info);
  const seeds: FeatureSeed[] = [];

  for (const sourceRoot of packageSourceRoots(info.root)) {
    if (!(await pathExists(join(root, sourceRoot)))) {
      continue;
    }
    const files = (await walk(root, [sourceRoot])).filter(isReviewableNodeSourceFile);
    if (files.length === 0) {
      continue;
    }
    for (const group of partitionSourceFiles(sourceRoot, files, sourceGroupMaxOwnedFiles)) {
      const tests = associatedTests(group.files, testFiles, testCommand);
      seeds.push({
        title: `Node source ${group.label}`,
        summary:
          group.files.length === 1
            ? `Node/TypeScript source file ${group.files[0]}.`
            : `Node/TypeScript source group ${group.label} with ${group.files.length} files.`,
        kind: packageKind(`${packageName} ${group.label}`),
        source: "node-source-group",
        confidence: "medium",
        entryPath: info.packageJsonPath,
        symbol: group.label,
        route: null,
        command: null,
        ownedFiles: group.files.map((path) => ({
          path,
          reason: `source group ${group.label}`,
        })),
        contextFiles: uniqueFileRefs([
          { path: info.packageJsonPath, reason: "package manifest" },
          ...tests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests,
        tags: ["node", "typescript", "source-group"],
        trustBoundaries: packageTrustBoundaries(`${packageName} ${group.label}`),
        testCommand,
        skipNearbyTests: true,
      });
    }
  }

  return seeds;
}

async function discoverPackages(
  root: string,
  rootPackage: NodePackageJson | null,
): Promise<PackageInfo[]> {
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

  const packages: PackageInfo[] = [];
  for (const packageRoot of [...packageRoots]
    .filter((path) => !isExcludedWorkspace(path, excludes))
    .toSorted()) {
    const packageJsonPath = packageRelativePath(packageRoot, "package.json");
    const packageJson = await readPackageJsonAt(root, packageJsonPath);
    if (packageJson !== null) {
      packages.push({ root: packageRoot, packageJsonPath, packageJson });
    }
  }
  return packages;
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
  for (const fallback of ["packages/*", "apps/*", "extensions/*", "plugins/*"]) {
    if (await pathExists(join(root, fallback.slice(0, -2)))) {
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
    return discoverPackageRoots(root, normalized.slice(0, -3), 4);
  }
  const singleSegmentParent = normalized.endsWith("/*") ? normalized.slice(0, -2) : null;
  if (singleSegmentParent !== null && !hasWorkspaceGlob(singleSegmentParent)) {
    const parent = singleSegmentParent;
    const entries = await safeDirectoryEntries(root, parent);
    const packageRoots: string[] = [];
    for (const entry of entries) {
      const candidate = `${parent}/${entry}`;
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

async function discoverPackageRoots(
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
  if (remainingDepth < 0 || shouldSkip(prefix)) {
    return;
  }
  if (await pathExists(join(root, prefix, "package.json"))) {
    output.push(prefix);
  }
  for (const entry of await safeDirectoryEntries(root, prefix)) {
    await discoverPackageRootsInto(root, `${prefix}/${entry}`, remainingDepth - 1, output);
  }
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
    if (shouldSkip(rel)) {
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

async function packageContextFiles(root: string, info: PackageInfo): Promise<SeedFileRef[]> {
  const candidates = ["README.md", "AGENTS.md", "tsconfig.json"].map((path) =>
    packageRelativePath(info.root, path),
  );
  const refs: SeedFileRef[] = [];
  for (const candidate of candidates) {
    if (candidate !== info.packageJsonPath && (await pathExists(join(root, candidate)))) {
      refs.push({ path: candidate, reason: "package context" });
    }
  }
  return refs;
}

function packageSourceRoots(packageRoot: string): string[] {
  return sourceDirectories.map((dir) => packageRelativePath(packageRoot, dir));
}

async function packageTestFiles(root: string, info: PackageInfo): Promise<string[]> {
  const prefixes = [
    ...packageSourceRoots(info.root),
    ...testDirectories.map((dir) => packageRelativePath(info.root, dir)),
  ];
  return (await walk(root, prefixes)).filter(isNodeTestPath).slice(0, 200);
}

function partitionSourceFiles(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
): SourceGroup[] {
  return partitionAt(sourceRoot, files.toSorted(), maxFiles, 0);
}

function partitionAt(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
  depth: number,
): SourceGroup[] {
  if (files.length <= maxFiles) {
    return [{ label: commonLabel(sourceRoot, files, depth), files }];
  }

  const directFiles: string[] = [];
  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const relativePath = file.slice(sourceRoot.length + 1);
    const parts = relativePath.split("/");
    if (parts.length <= depth + 1) {
      directFiles.push(file);
      continue;
    }
    const segment = parts[depth];
    if (segment === undefined) {
      directFiles.push(file);
      continue;
    }
    const bucket = buckets.get(segment) ?? [];
    bucket.push(file);
    buckets.set(segment, bucket);
  }

  if (buckets.size === 0) {
    return chunkFiles(currentLabel(sourceRoot, files, depth), files, maxFiles);
  }

  const groups = chunkFiles(currentLabel(sourceRoot, files, depth), directFiles, maxFiles);
  for (const [segment, bucketFiles] of [...buckets.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (bucketFiles.length <= maxFiles) {
      groups.push({
        label: `${sourceRoot}/${bucketPrefix(bucketFiles, sourceRoot, depth, segment)}`,
        files: bucketFiles,
      });
    } else {
      groups.push(...partitionAt(sourceRoot, bucketFiles, maxFiles, depth + 1));
    }
  }
  return groups;
}

function chunkFiles(label: string, files: string[], maxFiles: number): SourceGroup[] {
  if (files.length === 0) {
    return [];
  }
  if (files.length <= maxFiles) {
    return [{ label, files }];
  }
  const chunks: SourceGroup[] = [];
  for (let index = 0; index < files.length; index += maxFiles) {
    const part = Math.floor(index / maxFiles) + 1;
    chunks.push({
      label: `${label}#${part}`,
      files: files.slice(index, index + maxFiles),
    });
  }
  return chunks;
}

function currentLabel(sourceRoot: string, files: string[], depth: number): string {
  if (depth === 0) {
    return sourceRoot;
  }
  const first = files[0];
  if (first === undefined) {
    return sourceRoot;
  }
  const parts = first
    .slice(sourceRoot.length + 1)
    .split("/")
    .slice(0, depth);
  return parts.length === 0 ? sourceRoot : `${sourceRoot}/${parts.join("/")}`;
}

function commonLabel(sourceRoot: string, files: string[], depth: number): string {
  if (depth === 0) {
    return sourceRoot;
  }
  if (files.length === 1) {
    return files[0] ?? sourceRoot;
  }
  const first = files[0];
  if (first === undefined) {
    return sourceRoot;
  }
  const parts = first
    .slice(sourceRoot.length + 1)
    .split("/")
    .slice(0, depth);
  return parts.length === 0 ? sourceRoot : `${sourceRoot}/${parts.join("/")}`;
}

function bucketPrefix(files: string[], sourceRoot: string, depth: number, segment: string): string {
  const first = files[0];
  if (first === undefined || depth === 0) {
    return segment;
  }
  const parts = first
    .slice(sourceRoot.length + 1)
    .split("/")
    .slice(0, depth);
  return [...parts, segment].join("/");
}

function associatedTests(files: string[], tests: string[], command: string | null): SeedTestRef[] {
  const fileStems = new Set(files.map((file) => basename(file).replace(/\.[^.]+$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  return tests
    .filter((test) => {
      const testStem = basename(test).replace(/\.(test|spec)\.[^.]+$/u, "");
      return fileStems.has(testStem) || [...dirs].some((dir) => pathMatchesPrefix(test, dir));
    })
    .slice(0, sourceGroupMaxTests)
    .map((path) => ({ path, command }));
}

async function resolvePackageBinEntry(
  root: string,
  packageRoot: string,
  path: string,
): Promise<string> {
  const normalized = normalizePackagePath(path);
  const source = sourceCandidateForGeneratedBin(normalized);
  const candidate = packageRelativePath(packageRoot, source ?? normalized);
  if (source === null) {
    return candidate;
  }
  return (await pathExists(join(root, candidate)))
    ? candidate
    : packageRelativePath(packageRoot, normalized);
}

function sourceCandidateForGeneratedBin(path: string): string | null {
  const match = /^(?:dist|build)\/(.+)$/u.exec(path);
  if (match === null) {
    return null;
  }
  const suffix = match[1];
  if (suffix === undefined) {
    return null;
  }
  const extension = extname(suffix);
  if (![".js", ".mjs", ".cjs"].includes(extension)) {
    return null;
  }
  return `src/${suffix.slice(0, -extension.length)}.ts`;
}

function normalizePackagePath(path: string): string {
  return normalize(path).replace(/^\.\//u, "");
}

function packageRelativePath(packageRoot: string, path: string): string {
  return packageRoot === "." ? normalize(path) : normalize(join(packageRoot, path));
}

function packageDisplayName(info: PackageInfo): string {
  if (typeof info.packageJson.name === "string" && info.packageJson.name.length > 0) {
    return info.packageJson.name;
  }
  return info.root === "." ? basename(dirname(join(info.packageJsonPath))) : basename(info.root);
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

function scriptCommand(packageManager: string, packageRoot: string, script: string): string {
  if (packageRoot === ".") {
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

function isReviewableNodeSourceFile(path: string): boolean {
  return (
    /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(path) &&
    !isNodeTestPath(path) &&
    !/\.d\.[cm]?ts$/u.test(path) &&
    !/(^|\/)(__fixtures__|fixtures|testdata)(\/|$)/u.test(path) &&
    !/(^|\/)[^/]*(?:generated|\.gen)\.[^.]+$/iu.test(path)
  );
}

function isNodeTestPath(path: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(path);
}

function uniqueFileRefs(refs: SeedFileRef[]): SeedFileRef[] {
  const seen = new Set<string>();
  const output: SeedFileRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.path)) {
      continue;
    }
    seen.add(ref.path);
    output.push(ref);
  }
  return output;
}
