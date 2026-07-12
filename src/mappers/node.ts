import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { packageBins, packageScripts } from "../detect.js";
import { pathExists } from "../fs.js";
import { rubyDependencyNames, rubyGemspecPaths, stripRubyComments } from "../ruby.js";
import { partitionFileGroups } from "./grouping.js";
import {
  normalize,
  packageKind,
  packageTrustBoundaries,
  pathMatchesPrefix,
  walk,
} from "./shared.js";
import {
  packageRelativePath,
  projectContextFiles,
  projectDisplayName,
  projectTags,
  projectTargetCommand,
} from "./projects.js";
import type { NodePackageJson, NodeProjectInfo } from "./projects.js";
import type { WorkspaceTaskGraph } from "./task-graph.js";
import {
  FeatureSeed,
  MapperContext,
  SeedFileRef,
  SeedTestRef,
  suppressedTestCommandTag,
} from "./types.js";

type PackageInfo = NodeProjectInfo & {
  packageJsonPath: string;
  packageJson: NodePackageJson;
};

const sourceDirectories = ["src", "lib", "app", "pages", "scripts", "server", "api"] as const;
const testDirectories = ["test", "tests", "__tests__"] as const;
const sourceGroupMaxOwnedFiles = 12;
const sourceGroupMaxTests = 8;
const packageOverviewMaxContextFiles = 40;
const semanticSourceSegments = [
  "monitor",
  "webhook",
  "setup",
  "runtime",
  "commands",
  "command",
  "auth",
  "storage",
  "store",
  "config",
  "cli",
  "server",
  "client",
  "routes",
  "tools",
  "transport",
  "message",
  "session",
  "provider",
  "plugin",
  "plugins",
  "media",
  "security",
] as const;

export async function nodeSeeds(root: string, context: MapperContext): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];

  const projects = await context.nodeProjects();
  const taskGraph = await context.nodeTaskGraph();
  for (const info of projects) {
    if (hasNodePackage(info)) {
      seeds.push(...(await packageSeeds(root, info, taskGraph)));
    }
    seeds.push(...(await sourceGroupSeeds(root, info, taskGraph)));
  }

  return seeds;
}

function hasNodePackage(project: NodeProjectInfo): project is PackageInfo {
  return project.packageJsonPath !== null && project.packageJson !== null;
}

async function packageSeeds(
  root: string,
  info: PackageInfo,
  taskGraph: WorkspaceTaskGraph,
): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  const packageName = projectDisplayName(info);
  const packageTags = ["node", "package", ...projectTags(info)];
  if (info.root !== ".") {
    packageTags.push("workspace");
  }
  const testCommand = projectTargetCommand(info, "test", taskGraph);
  if (testCommand === null) {
    packageTags.push(suppressedTestCommandTag);
  }
  if (isExtensionPackage(info)) {
    packageTags.push("extension-package");
  }

  const packageOwnedFiles = await packageOwnedMetadataFiles(root, info);
  const packageOverviewContext = await packageOverviewContextFiles(root, info);
  const manifestSource = isExtensionPackage(info) ? "node-extension-package" : "node-package";
  const packageSummary = isExtensionPackage(info)
    ? `Extension package ${packageName} with package metadata, source, tests, and docs rooted at ${info.root}.`
    : `Node package ${packageName} with package metadata and review context rooted at ${info.root}.`;

  const manifestSeed: FeatureSeed = {
    title: `Node package ${packageName}`,
    summary: packageSummary,
    kind: packageKind(`${packageName} ${info.root}`),
    source: manifestSource,
    confidence: "medium",
    entryPath: info.packageJsonPath,
    symbol: packageName,
    route: null,
    command: null,
    ownedFiles: packageOwnedFiles,
    contextFiles: uniqueFileRefs(
      [...(await projectContextFiles(root, info)), ...packageOverviewContext].filter(
        (ref) => !packageOwnedFiles.some((owned) => owned.path === ref.path),
      ),
    ),
    tags: packageTags,
    trustBoundaries: packageTrustBoundaries(`${packageName} ${info.root}`),
    skipNearbyTests: true,
  };

  for (const [command, path] of Object.entries(packageBins(info.packageJson))) {
    const bin = await resolvePackageBinEntry(root, info, path);
    seeds.push({
      title: `CLI command ${command}`,
      summary:
        bin.entryPath === packageRelativePath(info.root, normalizePackagePath(path))
          ? `Package bin '${command}' at ${path}.`
          : `Package bin '${command}' at ${path}, source ${bin.entryPath}.`,
      kind: "cli-command",
      source: "package-json-bin",
      confidence: bin.confidence,
      entryPath: bin.entryPath,
      symbol: null,
      route: null,
      command,
      ownedFiles: bin.ownedFiles,
      contextFiles: bin.contextFiles,
      tags: ["node", "cli", ...(testCommand === null ? [suppressedTestCommandTag] : [])],
      trustBoundaries: ["user-input", "filesystem", "process-exec"],
      ...(testCommand === undefined ? {} : { testCommand }),
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
      tags: [
        "node",
        "package-script",
        ...projectTags(info),
        ...(testCommand === null ? [suppressedTestCommandTag] : []),
      ],
      trustBoundaries: script === "test" ? [] : ["process-exec", "filesystem"],
      skipNearbyTests: true,
    });
  }

  seeds.push(manifestSeed);
  return seeds;
}

async function sourceGroupSeeds(
  root: string,
  info: NodeProjectInfo,
  taskGraph: WorkspaceTaskGraph,
): Promise<FeatureSeed[]> {
  const packageName = projectDisplayName(info);
  const testCommand = projectTargetCommand(info, "test", taskGraph);
  const testFiles = await packageTestFiles(root, info);
  const railsPackage = await isRailsPackage(root, info.root);
  const seeds: FeatureSeed[] = [];

  for (const sourceRoot of packageSourceRoots(info, railsPackage)) {
    if (!(await pathExists(join(root, sourceRoot)))) {
      continue;
    }
    const files = (await walk(root, [sourceRoot])).filter(
      (path) =>
        isReviewableNodeSourceFile(path) &&
        !isRailsExcludedNodeSourcePath(info, railsPackage, sourceRoot, path),
    );
    if (files.length === 0) {
      continue;
    }
    for (const group of partitionNodeFileGroups(sourceRoot, files, sourceGroupMaxOwnedFiles)) {
      const tests = associatedTests(group.files, testFiles, testCommand ?? null);
      const entryPath =
        info.packageJsonPath ?? info.projectJsonPath ?? group.files[0] ?? sourceRoot;
      seeds.push({
        title: `Node source ${group.label}`,
        summary:
          group.files.length === 1
            ? `Node/TypeScript source file ${group.files[0]}.`
            : `Node/TypeScript source group ${group.label} with ${group.files.length} files.`,
        kind: packageKind(`${packageName} ${group.label}`),
        source: "node-source-group",
        confidence: "medium",
        entryPath,
        symbol: group.label,
        route: null,
        command: null,
        ownedFiles: group.files.map((path) => ({
          path,
          reason: `source group ${group.label}`,
        })),
        contextFiles: uniqueFileRefs([
          ...(info.packageJsonPath === null
            ? await projectContextFiles(root, info)
            : [{ path: info.packageJsonPath, reason: "package manifest" }]),
          ...tests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests,
        tags: [
          "node",
          "typescript",
          "source-group",
          ...(info.packageJsonPath === null ? ["generic-project"] : []),
          ...projectTags(info),
          ...(testCommand === null ? [suppressedTestCommandTag] : []),
        ],
        trustBoundaries: packageTrustBoundaries(`${packageName} ${group.label}`),
        ...(testCommand === undefined ? {} : { testCommand }),
        skipNearbyTests: true,
      });
    }
  }

  return seeds;
}

async function packageOwnedMetadataFiles(root: string, info: PackageInfo): Promise<SeedFileRef[]> {
  return existingFileRefs(root, [
    { path: info.packageJsonPath, reason: "package manifest" },
    { path: packageRelativePath(info.root, "tsconfig.json"), reason: "typescript configuration" },
    {
      path: packageRelativePath(info.root, "tsconfig.build.json"),
      reason: "typescript build configuration",
    },
    { path: packageRelativePath(info.root, "vitest.config.ts"), reason: "test configuration" },
    { path: packageRelativePath(info.root, "vitest.config.mts"), reason: "test configuration" },
    { path: packageRelativePath(info.root, "vite.config.ts"), reason: "build configuration" },
    { path: packageRelativePath(info.root, "tsdown.config.ts"), reason: "build configuration" },
  ]);
}

async function packageOverviewContextFiles(
  root: string,
  info: PackageInfo,
): Promise<SeedFileRef[]> {
  const docs = await existingFileRefs(root, [
    { path: packageRelativePath(info.root, "README.md"), reason: "package documentation" },
    { path: packageRelativePath(info.root, "AGENTS.md"), reason: "package instructions" },
    { path: packageRelativePath(info.root, "CHANGELOG.md"), reason: "package changelog" },
  ]);
  const entryRefs = await packageEntryContextFiles(root, info);
  const sourceRefs = await packageSourceOverviewRefs(root, info);
  const testRefs = (await packageTestFiles(root, info))
    .slice(0, 12)
    .map((path) => ({ path, reason: "package test" }));
  return uniqueFileRefs([...docs, ...entryRefs, ...sourceRefs, ...testRefs]).slice(
    0,
    packageOverviewMaxContextFiles,
  );
}

async function packageEntryContextFiles(root: string, info: PackageInfo): Promise<SeedFileRef[]> {
  const entries = new Set<string>();
  for (const path of Object.values(packageBins(info.packageJson))) {
    const normalized = normalizePackagePath(path);
    const sourceCandidates = sourceCandidatesForGeneratedOutput(normalized);
    for (const candidate of sourceCandidates) {
      entries.add(packageRelativePath(info.root, candidate));
    }
    if (sourceCandidates.length === 0) {
      entries.add(packageRelativePath(info.root, normalized));
    }
  }
  for (const path of packageExportPaths(info.packageJson)) {
    const normalized = normalizePackagePath(path);
    const sourceCandidates = sourceCandidatesForGeneratedOutput(normalized);
    for (const candidate of sourceCandidates) {
      entries.add(packageRelativePath(info.root, candidate));
    }
    if (sourceCandidates.length === 0) {
      entries.add(packageRelativePath(info.root, normalized));
    }
  }
  return existingFileRefs(
    root,
    [...entries].map((path) => ({ path, reason: "package entrypoint" })),
  );
}

function packageExportPaths(pkg: PackageInfo["packageJson"]): string[] {
  const output: string[] = [];
  for (const value of [pkg.main, pkg.module, pkg.types]) {
    if (typeof value === "string") {
      output.push(value);
    }
  }
  collectExportPaths(pkg.exports, output);
  return [...new Set(output)];
}

function collectExportPaths(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const item of Object.values(value)) {
    collectExportPaths(item, output);
  }
}

async function packageSourceOverviewRefs(root: string, info: PackageInfo): Promise<SeedFileRef[]> {
  const railsPackage = await isRailsPackage(root, info.root);
  const sourceRoots = packageSourceRoots(info, railsPackage);
  const files = (
    await Promise.all(
      sourceRoots.map(async (sourceRoot) =>
        (await walk(root, [sourceRoot])).filter(
          (path) =>
            isReviewableNodeSourceFile(path) &&
            !isRailsExcludedNodeSourcePath(info, railsPackage, sourceRoot, path),
        ),
      ),
    )
  )
    .flat()
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, 24);
  return files.map((path) => ({ path, reason: "package source overview" }));
}

async function existingFileRefs(root: string, refs: SeedFileRef[]): Promise<SeedFileRef[]> {
  const output: SeedFileRef[] = [];
  for (const ref of uniqueFileRefs(refs)) {
    if (await pathExists(join(root, ref.path))) {
      output.push(ref);
    }
  }
  return output;
}

function packageSourceRoots(info: NodeProjectInfo, railsPackage: boolean): string[] {
  if (railsPackage) {
    return [
      ...new Set(
        [...sourceDirectories, "app/javascript", "app/packs", "app/frontend"].map((dir) =>
          packageRelativePath(info.root, dir),
        ),
      ),
    ].filter((path) => !pathMatchesPrefix(path, packageRelativePath(info.root, "app/assets")));
  }
  return shallowSourceRoots([
    ...new Set([
      ...(info.sourceRoot === null ? [] : [info.sourceRoot]),
      ...sourceDirectories.map((dir) => packageRelativePath(info.root, dir)),
    ]),
  ]);
}

function shallowSourceRoots(sourceRoots: string[]): string[] {
  return sourceRoots.filter(
    (sourceRoot) =>
      !sourceRoots.some(
        (other) => other !== sourceRoot && (other === "." || pathMatchesPrefix(sourceRoot, other)),
      ),
  );
}

function isRailsExcludedNodeSourcePath(
  info: NodeProjectInfo,
  railsPackage: boolean,
  sourceRoot: string,
  path: string,
): boolean {
  if (!railsPackage) {
    return false;
  }
  if (pathMatchesPrefix(path, packageRelativePath(info.root, "app/assets"))) {
    return true;
  }
  if (sourceRoot !== packageRelativePath(info.root, "app")) {
    return false;
  }
  return ["app/javascript", "app/packs", "app/frontend"].some((dir) =>
    pathMatchesPrefix(path, packageRelativePath(info.root, dir)),
  );
}

async function packageTestFiles(root: string, info: NodeProjectInfo): Promise<string[]> {
  const railsPackage = await isRailsPackage(root, info.root);
  const prefixes = [
    ...packageSourceRoots(info, railsPackage),
    ...testDirectories.map((dir) => packageRelativePath(info.root, dir)),
  ];
  return (await walk(root, prefixes)).filter(isNodeTestPath).slice(0, 200);
}

async function isRailsPackage(root: string, packageRoot: string): Promise<boolean> {
  return (
    packageRoot === "." &&
    (await pathExists(join(root, "config/application.rb"))) &&
    (await hasRailsDependency(root))
  );
}

async function hasRailsDependency(root: string): Promise<boolean> {
  const chunks: string[] = [];
  for (const path of ["Gemfile", "gems.rb"]) {
    if (await pathExists(join(root, path))) {
      chunks.push(await readFile(join(root, path), "utf8"));
    }
  }
  for (const path of await rubyGemspecPaths(root)) {
    chunks.push(await readFile(join(root, path), "utf8"));
  }
  return rubyDependencyNames(stripRubyComments(chunks.join("\n"))).has("rails");
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
  info: PackageInfo,
  path: string,
): Promise<{
  entryPath: string;
  ownedFiles: SeedFileRef[];
  contextFiles: SeedFileRef[];
  confidence: FeatureSeed["confidence"];
}> {
  const normalized = normalizePackagePath(path);
  const sourceCandidates = sourceCandidatesForGeneratedOutput(normalized);
  if (sourceCandidates.length === 0) {
    const candidate = packageRelativePath(info.root, normalized);
    return {
      entryPath: candidate,
      ownedFiles: [{ path: candidate, reason: "package bin entrypoint" }],
      contextFiles: [{ path: info.packageJsonPath, reason: "package manifest" }],
      confidence: "high",
    };
  }
  for (const source of sourceCandidates) {
    const candidate = packageRelativePath(info.root, source);
    if (await pathExists(join(root, candidate))) {
      return {
        entryPath: candidate,
        ownedFiles: [{ path: candidate, reason: "entrypoint" }],
        contextFiles: [{ path: info.packageJsonPath, reason: "package manifest" }],
        confidence: "high",
      };
    }
  }
  return {
    entryPath: info.packageJsonPath,
    ownedFiles: [
      { path: info.packageJsonPath, reason: "package manifest declaring generated bin" },
    ],
    contextFiles: [],
    confidence: "low",
  };
}

function sourceCandidatesForGeneratedOutput(path: string): string[] {
  const match = /^(?:dist|build)\/(.+)$/u.exec(path);
  if (match === null) {
    return [];
  }
  const suffix = match[1];
  if (suffix === undefined) {
    return [];
  }
  if (suffix.endsWith(".d.mts")) {
    const stem = suffix.slice(0, -".d.mts".length);
    return [`src/${stem}.mts`, `src/${stem}.ts`, `src/${stem}.tsx`];
  }
  if (suffix.endsWith(".d.cts")) {
    const stem = suffix.slice(0, -".d.cts".length);
    return [`src/${stem}.cts`, `src/${stem}.ts`, `src/${stem}.tsx`];
  }
  if (suffix.endsWith(".d.ts")) {
    const stem = suffix.slice(0, -".d.ts".length);
    return [`src/${stem}.ts`, `src/${stem}.tsx`];
  }
  const extension = extname(suffix);
  const stem = suffix.slice(0, -extension.length);
  if (extension === ".mjs") {
    return [
      `src/${stem}.mts`,
      `src/${stem}.ts`,
      `src/${stem}.tsx`,
      `src/${stem}.mjs`,
      `src/${stem}.js`,
    ];
  }
  if (extension === ".cjs") {
    return [
      `src/${stem}.cts`,
      `src/${stem}.ts`,
      `src/${stem}.tsx`,
      `src/${stem}.cjs`,
      `src/${stem}.js`,
    ];
  }
  if (extension === ".js") {
    return [`src/${stem}.ts`, `src/${stem}.tsx`, `src/${stem}.js`, `src/${stem}.jsx`];
  }
  return [];
}

function normalizePackagePath(path: string): string {
  return normalize(path).replace(/^\.\//u, "");
}

function isReviewableNodeSourceFile(path: string): boolean {
  return (
    /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(path) &&
    !isNodeTestPath(path) &&
    !/\.d\.[cm]?ts$/u.test(path) &&
    !/(^|\/)(__fixtures__|fixtures|testdata)(\/|$)/u.test(path) &&
    !/(^|\/)(generated|__generated__)(\/|$)/iu.test(path) &&
    !/(^|\/)[^/]*(?:generated|\.gen)\.[^.]+$/iu.test(path)
  );
}

function partitionNodeFileGroups(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
): ReturnType<typeof partitionFileGroups> {
  if (files.length <= maxFiles) {
    return partitionFileGroups(sourceRoot, files, maxFiles);
  }
  const buckets = new Map<string, string[]>();
  const fallbackFiles: string[] = [];
  for (const file of files) {
    const relativePath = file.slice(sourceRoot.length + 1);
    if (relativePath.includes("/")) {
      fallbackFiles.push(file);
      continue;
    }
    const segment = semanticSegmentForFile(file);
    if (segment === null) {
      fallbackFiles.push(file);
      continue;
    }
    const bucket = buckets.get(segment) ?? [];
    bucket.push(file);
    buckets.set(segment, bucket);
  }
  if (buckets.size === 0) {
    return partitionFileGroups(sourceRoot, files, maxFiles);
  }
  const fallbackGroups = partitionFileGroups(sourceRoot, fallbackFiles, maxFiles);
  const fallbackLabels = new Set(fallbackGroups.map((group) => group.label));
  const output: ReturnType<typeof partitionFileGroups> = [];
  for (const [segment, bucketFiles] of [...buckets.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    output.push(
      ...chunkSemanticGroup(
        semanticFileGroupLabel(sourceRoot, segment, fallbackLabels),
        bucketFiles,
        maxFiles,
      ),
    );
  }
  output.push(...fallbackGroups);
  return output;
}

function semanticFileGroupLabel(
  sourceRoot: string,
  segment: string,
  existing: Set<string>,
): string {
  let label = `${sourceRoot}/:${segment}`;
  let index = 2;
  while (existing.has(label)) {
    label = `${sourceRoot}/:${segment}#${index}`;
    index += 1;
  }
  return label;
}

function chunkSemanticGroup(
  label: string,
  files: string[],
  maxFiles: number,
): ReturnType<typeof partitionFileGroups> {
  const sortedFiles = files.toSorted();
  if (sortedFiles.length <= maxFiles) {
    return [{ label, files: sortedFiles }];
  }
  const groups: ReturnType<typeof partitionFileGroups> = [];
  for (let index = 0; index < sortedFiles.length; index += maxFiles) {
    groups.push({
      label: `${label}#${Math.floor(index / maxFiles) + 1}`,
      files: sortedFiles.slice(index, index + maxFiles),
    });
  }
  return groups;
}

function semanticSegmentForFile(path: string): string | null {
  const basenameWithoutExtension = basename(path)
    .replace(/\.[^.]+$/u, "")
    .toLowerCase();
  const tokens = new Set(
    basenameWithoutExtension.split(/[^a-z0-9]+/u).filter((token) => token.length > 0),
  );
  for (const segment of semanticSourceSegments) {
    if (tokens.has(segment) || basenameWithoutExtension.includes(segment)) {
      return segment === "command" ? "commands" : segment;
    }
  }
  return null;
}

function isExtensionPackage(info: PackageInfo): boolean {
  return (
    pathMatchesPrefix(info.root, "extensions") ||
    pathMatchesPrefix(info.root, "plugins") ||
    /\b(plugin|extension)\b/iu.test(projectDisplayName(info))
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
