import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../fs.js";
import { shellQuotePath } from "../shell.js";
import {
  normalize,
  isSampleProjectPath,
  packageTrustBoundaries,
  pathMatchesPrefix,
  shouldSkip,
  stripSwiftComments,
  walk,
} from "./shared.js";
import { FeatureSeed, SeedFileRef, SeedTestRef } from "./types.js";

export async function swiftSeeds(root: string): Promise<FeatureSeed[]> {
  const packageRoots = await discoverSwiftPackageRoots(root);
  const seeds: FeatureSeed[] = [];
  for (const packageRoot of packageRoots) {
    const packagePath = packageRoot === "." ? root : join(root, packageRoot);
    const packageSeeds = await swiftPackageSeeds(packagePath);
    seeds.push(...packageSeeds.map((seed) => prefixSwiftSeed(seed, packageRoot)));
  }
  return seeds;
}

async function swiftPackageSeeds(root: string): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  const manifestTargets = await swiftManifestTargets(root);
  const swiftTestCommand = "swift test";
  const customTestPathPrefixes = manifestTargets.testPaths.flatMap(swiftTestPathPrefixes);
  const sourcePathClaimsFile = (file: string) =>
    manifestTargets.sourcePaths.some(
      (entry) =>
        (entry.path !== "" || entry.sources.length > 0) && pathMatchesSwiftPath(file, entry),
    );
  const customSourcePathPrefixes = manifestTargets.sourcePaths.flatMap(swiftPathPrefixes);
  const testPathPrefixes = ["Tests", ...customTestPathPrefixes];
  const sourceFiles = (await walk(root, ["Sources", ...customSourcePathPrefixes])).filter(
    (file) =>
      file.endsWith(".swift") &&
      file !== "Package.swift" &&
      !testPathPrefixes.some(
        (prefix) => pathMatchesPrefix(file, prefix) && !sourcePathClaimsFile(file),
      ),
  );
  const targetFiles = groupSwiftFiles(
    sourceFiles,
    manifestTargets.source,
    manifestTargets.sourcePaths,
    manifestTargets.sourceDeclared,
  );
  for (const [target, files] of targetFiles) {
    const mainFile = files.find((file) => file === "main.swift" || file.endsWith("/main.swift"));
    const atMainFile = await firstAtMainFile(root, files);
    const executable =
      manifestTargets.executable.has(target) || mainFile !== undefined || atMainFile !== null;
    const entryPath = mainFile ?? atMainFile ?? files[0];
    if (entryPath === undefined) {
      continue;
    }
    seeds.push({
      title: executable ? `Swift executable ${target}` : `Swift target ${target}`,
      summary:
        executable === true
          ? `SwiftPM executable target ${target} at ${entryPath}.`
          : `SwiftPM target ${target} at ${entryPath}.`,
      kind: executable ? "cli-command" : "library",
      source: executable ? "swiftpm-executable" : "swiftpm-target",
      confidence: "medium",
      entryPath,
      symbol: executable ? "main" : null,
      route: null,
      command: executable ? target : null,
      tags: ["swift", "swiftpm"],
      trustBoundaries: executable ? ["user-input", "filesystem"] : packageTrustBoundaries(target),
      testCommand: swiftTestCommand,
      testPrefixes: swiftTestPrefixesForTarget(
        target,
        manifestTargets.testPaths,
        manifestTargets.testDependencies,
      ),
    });
  }
  const testFiles = (await walk(root, ["Tests", ...customTestPathPrefixes])).filter(
    (file) =>
      file.endsWith(".swift") &&
      !sourcePathClaimsFile(file) &&
      (file.startsWith("Tests/") ||
        customTestPathPrefixes.some((prefix) => pathMatchesPrefix(file, prefix))),
  );
  for (const [target, files] of groupSwiftFiles(
    testFiles,
    manifestTargets.test,
    manifestTargets.testPaths,
    false,
  )) {
    const entryPath = files[0];
    if (entryPath === undefined) {
      continue;
    }
    seeds.push({
      title: `Swift test suite ${target}`,
      summary: `SwiftPM test target ${target} at ${entryPath}.`,
      kind: "test-suite",
      source: "swiftpm-test-target",
      confidence: "medium",
      entryPath,
      symbol: null,
      route: null,
      command: null,
      tags: ["swift", "test"],
      trustBoundaries: [],
    });
  }
  return seeds;
}

async function discoverSwiftPackageRoots(root: string): Promise<string[]> {
  const roots: string[] = [];
  await discoverSwiftPackageRootsInto(root, ".", 5, roots);
  return roots.toSorted((left, right) => {
    if (left === ".") {
      return -1;
    }
    if (right === ".") {
      return 1;
    }
    return left.localeCompare(right);
  });
}

async function discoverSwiftPackageRootsInto(
  root: string,
  dir: string,
  remainingDepth: number,
  roots: string[],
): Promise<void> {
  if (
    remainingDepth < 0 ||
    (dir !== "." && (shouldSkip(dir) || isSampleProjectPath(dir) || isSwiftVendoredPath(dir)))
  ) {
    return;
  }
  const full = dir === "." ? root : join(root, dir);
  if (!(await pathExists(full))) {
    return;
  }
  const info = await lstat(full);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return;
  }
  if (await pathExists(join(full, "Package.swift"))) {
    roots.push(dir);
  }
  for (const entry of await readdir(full)) {
    const child = dir === "." ? entry : `${dir}/${entry}`;
    if (shouldSkip(child) || isSampleProjectPath(child) || isSwiftVendoredPath(child)) {
      continue;
    }
    const childInfo = await lstat(join(full, entry));
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      await discoverSwiftPackageRootsInto(root, child, remainingDepth - 1, roots);
    }
  }
}

function isSwiftVendoredPath(path: string): boolean {
  return path
    .split("/")
    .some((part) => ["Pods", "Carthage", "SourcePackages", ".swiftpm"].includes(part));
}

function prefixSwiftSeed(seed: FeatureSeed, packageRoot: string): FeatureSeed {
  if (packageRoot === ".") {
    return seed;
  }
  const testCommand =
    seed.testCommand === null ? null : `swift test --package-path ${shellQuotePath(packageRoot)}`;
  const prefixed: FeatureSeed = {
    ...seed,
    title: `${seed.title} (${packageRoot})`,
    summary: `${seed.summary} Package root: ${packageRoot}.`,
    entryPath: prefixSwiftPath(packageRoot, seed.entryPath),
    testCommand,
  };
  const ownedFiles = prefixFileRefs(packageRoot, seed.ownedFiles);
  const contextFiles = prefixFileRefs(packageRoot, seed.contextFiles);
  const tests = prefixTestRefs(packageRoot, seed.tests);
  if (ownedFiles !== undefined) {
    prefixed.ownedFiles = ownedFiles;
  }
  if (contextFiles !== undefined) {
    prefixed.contextFiles = contextFiles;
  }
  if (tests !== undefined) {
    prefixed.tests = tests;
  }
  if (seed.testPrefixes !== undefined) {
    prefixed.testPrefixes = seed.testPrefixes.map((prefix) => prefixSwiftPath(packageRoot, prefix));
  }
  return prefixed;
}

function prefixFileRefs(
  packageRoot: string,
  refs: SeedFileRef[] | undefined,
): SeedFileRef[] | undefined {
  return refs?.map((ref) => ({ ...ref, path: prefixSwiftPath(packageRoot, ref.path) }));
}

function prefixTestRefs(
  packageRoot: string,
  refs: SeedTestRef[] | undefined,
): SeedTestRef[] | undefined {
  return refs?.map((ref) => ({
    ...ref,
    path: prefixSwiftPath(packageRoot, ref.path),
    command:
      ref.command === null ? null : `swift test --package-path ${shellQuotePath(packageRoot)}`,
  }));
}

function prefixSwiftPath(packageRoot: string, path: string): string {
  return path === "" ? packageRoot : `${packageRoot}/${path}`;
}

async function swiftManifestTargets(root: string): Promise<{
  executable: Set<string>;
  source: Set<string>;
  test: Set<string>;
  sourcePaths: SwiftPathEntry[];
  testPaths: SwiftPathEntry[];
  testDependencies: Map<string, string[]>;
  sourceDeclared: boolean;
}> {
  const manifest = await readFile(join(root, "Package.swift"), "utf8");
  const executables = targetEntries(manifest, "executableTarget");
  const libraries = targetEntries(manifest, "target");
  const tests = targetEntries(manifest, "testTarget");
  const validExecutables = executables.filter((target) => target.valid);
  const validLibraries = libraries.filter((target) => target.valid);
  const validTests = tests.filter((target) => target.valid);
  const executable = new Set(validExecutables.map((target) => target.name));
  const library = new Set(validLibraries.map((target) => target.name));
  const test = new Set(validTests.map((target) => target.name));
  return {
    executable,
    source: new Set([...executable, ...library]),
    test,
    sourcePaths: targetPathEntries([...validExecutables, ...validLibraries]),
    testPaths: targetPathEntries(validTests),
    testDependencies: new Map(validTests.map((target) => [target.name, target.dependencies])),
    sourceDeclared: executables.length + libraries.length > 0,
  };
}

type SwiftTargetEntry = {
  name: string;
  path: string | null;
  valid: boolean;
  dependencies: string[];
  sources: string[];
};

type SwiftPathEntry = {
  path: string;
  target: string;
  sources: string[];
};

function targetEntries(manifest: string, kind: string): SwiftTargetEntry[] {
  const uncommentedManifest = stripSwiftComments(manifest);
  const entries: SwiftTargetEntry[] = [];
  let consumedUntil = -1;
  for (const match of uncommentedManifest.matchAll(
    /\.(executableTarget|testTarget|target)\s*\(/gu,
  )) {
    if (match.index === undefined || match.index < consumedUntil) {
      continue;
    }
    const openIndex = uncommentedManifest.indexOf("(", match.index);
    const closeIndex = matchingParenEnd(uncommentedManifest, openIndex);
    if (closeIndex === -1) {
      continue;
    }
    consumedUntil = closeIndex + 1;
    if (match[1] !== kind) {
      continue;
    }
    const block = uncommentedManifest.slice(match.index, closeIndex + 1);
    const name = /name:\s*"([^"]+)"/u.exec(block)?.[1];
    if (name === undefined) {
      continue;
    }
    const dependencies = swiftTargetDependencies(block);
    const pathMatch = /path:\s*"([^"]+)"/u.exec(block);
    const path = normalizeManifestPath(pathMatch?.[1] ?? null);
    const sources = swiftStringArray(block, "sources")
      .map(normalizeManifestPath)
      .filter((source): source is string => source !== null);
    if (pathMatch !== null && path === null) {
      entries.push({ name, path: null, valid: false, dependencies, sources });
      continue;
    }
    entries.push({
      name,
      path,
      valid: true,
      dependencies,
      sources,
    });
  }
  return entries;
}

function swiftTargetDependencies(block: string): string[] {
  const dependencyLabel = /dependencies:\s*\[/u.exec(block);
  if (dependencyLabel?.index === undefined) {
    return [];
  }
  const openIndex = block.indexOf("[", dependencyLabel.index);
  const closeIndex = matchingBracketEnd(block, openIndex);
  if (closeIndex === -1) {
    return [];
  }
  const dependencyBlock = block.slice(openIndex + 1, closeIndex);
  const dependencies = new Set<string>();
  for (const match of dependencyBlock.matchAll(/(?:^|,)\s*"([^"]+)"/gu)) {
    if (match[1] !== undefined) {
      dependencies.add(match[1]);
    }
  }
  for (const match of dependencyBlock.matchAll(/\.(?:target|byName)\s*\(\s*name:\s*"([^"]+)"/gu)) {
    if (match[1] !== undefined) {
      dependencies.add(match[1]);
    }
  }
  return [...dependencies];
}

function swiftStringArray(block: string, label: string): string[] {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const arrayLabel = new RegExp(`${escapedLabel}:\\s*\\[`, "u").exec(block);
  if (arrayLabel?.index === undefined) {
    return [];
  }
  const openIndex = block.indexOf("[", arrayLabel.index);
  const closeIndex = matchingBracketEnd(block, openIndex);
  if (closeIndex === -1) {
    return [];
  }
  return [...block.slice(openIndex + 1, closeIndex).matchAll(/"([^"]+)"/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function matchingBracketEnd(source: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function matchingParenEnd(source: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function targetPathEntries(entries: SwiftTargetEntry[]): SwiftPathEntry[] {
  return entries.flatMap((entry) =>
    entry.path === null ? [] : [{ path: entry.path, target: entry.name, sources: entry.sources }],
  );
}

function normalizeManifestPath(path: string | null): string | null {
  if (path === null) {
    return null;
  }
  const normalized = normalize(path).replace(/^\.\//u, "").replace(/\/$/u, "");
  if (normalized === ".") {
    return "";
  }
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return null;
  }
  return normalized;
}

async function firstAtMainFile(root: string, files: string[]): Promise<string | null> {
  for (const file of files) {
    const source = stripSwiftComments(await readFile(join(root, file), "utf8"));
    if (/^\s*@main\b/mu.test(source)) {
      return file;
    }
  }
  return null;
}

function groupSwiftFiles(
  files: string[],
  manifestTargets: Set<string>,
  manifestPaths: SwiftPathEntry[],
  requireKnownTarget = false,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  const flatTarget = manifestTargets.size === 1 ? manifestTargets.values().next().value : undefined;
  const customPaths = [...manifestPaths].toSorted((a, b) => b.path.length - a.path.length);
  for (const file of files) {
    const parts = file.split("/");
    const pathTarget = customPaths.find((entry) => pathMatchesSwiftPath(file, entry))?.target;
    const target =
      pathTarget ??
      (parts.length === 2 && flatTarget !== undefined ? flatTarget : file.split("/").at(1));
    if (target === undefined || (requireKnownTarget && !manifestTargets.has(target))) {
      continue;
    }
    const list = grouped.get(target) ?? [];
    list.push(file);
    grouped.set(target, list);
  }
  return grouped;
}

function swiftTestPrefixesForTarget(
  target: string,
  testPaths: SwiftPathEntry[] = [],
  testDependencies = new Map<string, string[]>(),
): string[] {
  const dependentTestTargets = [...testDependencies.entries()]
    .filter(([, dependencies]) => dependencies.includes(target))
    .map(([testTarget]) => testTarget);
  const custom = testPaths
    .filter(
      ({ target: testTarget }) =>
        testTarget === `${target}Tests` ||
        testTarget === target ||
        dependentTestTargets.includes(testTarget),
    )
    .flatMap(swiftTestPathPrefixes);
  const dependentDefaults = dependentTestTargets.map((testTarget) => `Tests/${testTarget}/`);
  return [...custom, ...dependentDefaults, `Tests/${target}Tests/`, `Tests/${target}/`];
}

function swiftPathPrefixes(entry: SwiftPathEntry): string[] {
  if (entry.sources.length === 0) {
    return [entry.path];
  }
  return entry.sources.map((source) => (entry.path === "" ? source : `${entry.path}/${source}`));
}

function swiftTestPathPrefixes(entry: SwiftPathEntry): string[] {
  return swiftPathPrefixes(entry).filter((prefix) => prefix !== "");
}

function pathMatchesSwiftPath(path: string, entry: SwiftPathEntry): boolean {
  if (!pathMatchesPrefix(path, entry.path)) {
    return false;
  }
  if (entry.sources.length === 0) {
    return true;
  }
  const relativePath = entry.path === "" ? path : path.slice(entry.path.length + 1);
  return entry.sources.some((source) => pathMatchesPrefix(relativePath, source));
}
