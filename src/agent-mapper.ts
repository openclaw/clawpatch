import { isAbsolute, join } from "node:path";
import { buildAgentMapPrompt } from "./prompt.js";
import { ClawpatchError } from "./errors.js";
import { Provider, ProviderOptions } from "./provider.js";
import { AgentMapOutput, FeatureRecord, ProjectRecord } from "./types.js";
import { pathExists } from "./fs.js";
import { runCommandArgs } from "./exec.js";
import { mapFeatureSeeds, MapResult } from "./mapper.js";
import { FeatureSeed, SeedFileRef, SeedTestRef } from "./mappers/types.js";
import {
  applyPathFilters,
  isSafeFile,
  normalize,
  PathFilters,
  shouldSkip,
  walk,
} from "./mappers/shared.js";

type AgentMapMode = "heuristic" | "auto" | "agent";

export type MapSourceDecision = {
  source: AgentMapMode;
  usedAgent: boolean;
  reason: string;
  inventory: RepoInventorySummary;
};

export type AgentMapResult = MapResult & {
  decision: MapSourceDecision;
};

type AgentMapOptions = {
  source: AgentMapMode;
  provider: Provider | null;
  providerOptions: ProviderOptions;
  inventory?: PathFilters;
  onProgress?: (event: string, fields: Record<string, string | number | boolean>) => void;
};

type RepoInventorySummary = {
  files: number;
  sourceFiles: number;
  testFiles: number;
  ownedSourceFiles: number;
  sourceCoverage: number;
  weak: boolean;
  weakReason: string;
};

type RepoInventory = RepoInventorySummary & {
  allFiles: Set<string>;
  manifests: string[];
  topLevelDirs: string[];
  fileSamples: string[];
  sourceFileSamples: string[];
  testFileSamples: string[];
};

const sourceExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".cxx",
  ".ex",
  ".exs",
  ".fs",
  ".fsi",
  ".go",
  ".h",
  ".heex",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".m",
  ".mm",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
  ".vb",
]);

const manifestNames = new Set([
  "Cargo.toml",
  "CMakeLists.txt",
  "Package.swift",
  "Directory.Build.props",
  "Directory.Build.targets",
  "Directory.Packages.props",
  "Directory.Packages.targets",
  "NuGet.config",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "global.json",
  "go.mod",
  "mix.exs",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "settings.gradle",
  "settings.gradle.kts",
  "turbo.json",
]);

export async function mapWithSource(
  root: string,
  project: ProjectRecord,
  existing: FeatureRecord[],
  heuristic: MapResult,
  options: AgentMapOptions,
): Promise<AgentMapResult> {
  const inventoryStarted = Date.now();
  options.onProgress?.("inventory-start", {});
  const inventory = await repoInventory(root, project, heuristic.features, options.inventory);
  options.onProgress?.("inventory-done", {
    files: inventory.files,
    sourceFiles: inventory.sourceFiles,
    ownedSourceFiles: inventory.ownedSourceFiles,
    weak: inventory.weak,
    elapsed: `${Math.round((Date.now() - inventoryStarted) / 1000)}s`,
  });
  if (options.source === "heuristic") {
    options.onProgress?.("agent-skip", { reason: "heuristic" });
    return withDecision(heuristic, options.source, false, "heuristic mapper selected", inventory);
  }
  if (options.source === "auto" && !inventory.weak) {
    options.onProgress?.("agent-skip", { reason: "meaningful-heuristic" });
    return withDecision(heuristic, options.source, false, "heuristic map is meaningful", inventory);
  }
  if (options.provider === null) {
    throw new Error("agent mapper provider is required");
  }
  const agentStarted = Date.now();
  options.onProgress?.("agent-start", {
    provider: options.provider.name,
    model: options.providerOptions.model ?? "default",
  });
  const agent = await agentMap(
    root,
    project,
    existing,
    options.provider,
    options.providerOptions,
    inventory,
    options.inventory,
  );
  options.onProgress?.("agent-done", {
    features: agent.features.length,
    elapsed: `${Math.round((Date.now() - agentStarted) / 1000)}s`,
  });
  if (agent.features.length === 0) {
    if (options.source === "agent") {
      throw new ClawpatchError("agent mapper returned no valid features", 8, "malformed-output");
    }
    return withDecision(
      heuristic,
      options.source,
      true,
      "agent mapper returned no valid features; kept heuristic map",
      inventory,
    );
  }
  return withDecision(
    mergeMapResults(heuristic, agent, existing),
    options.source,
    true,
    inventory.weakReason,
    inventory,
  );
}

function withDecision(
  result: MapResult,
  source: AgentMapMode,
  usedAgent: boolean,
  reason: string,
  inventory: RepoInventorySummary,
): AgentMapResult {
  return {
    ...result,
    decision: {
      source,
      usedAgent,
      reason,
      inventory,
    },
  };
}

async function agentMap(
  root: string,
  project: ProjectRecord,
  existing: FeatureRecord[],
  provider: Provider,
  providerOptions: ProviderOptions,
  inventory: RepoInventory,
  filters: PathFilters | undefined,
): Promise<MapResult> {
  const prompt = buildAgentMapPrompt(project, {
    manifests: inventory.manifests,
    topLevelDirs: inventory.topLevelDirs,
    sourceFiles: inventory.sourceFileSamples,
    testFiles: inventory.testFileSamples,
    files: inventory.fileSamples,
    summary: inventorySummary(inventory),
  });
  const output = await provider.map(root, prompt, providerOptions);
  const seeds = await Promise.all(
    output.features.map((feature) => toSeed(root, feature, inventory.allFiles)),
  );
  const mappedSeeds = uniqueSeeds(seeds.filter((seed): seed is FeatureSeed => seed !== null));
  return filters === undefined
    ? mapFeatureSeeds(root, project, existing, mappedSeeds)
    : mapFeatureSeeds(root, project, existing, mappedSeeds, { filters });
}

async function toSeed(
  root: string,
  feature: AgentMapOutput["features"][number],
  allowedFiles: ReadonlySet<string>,
): Promise<FeatureSeed | null> {
  const ownedFiles = await validFileRefs(root, feature.ownedFiles, allowedFiles, 60);
  if (ownedFiles.length === 0) {
    return null;
  }
  const contextFiles = await validFileRefs(root, feature.contextFiles, allowedFiles, 80);
  const tests = await validTests(root, feature.tests, allowedFiles, 20);
  const entrypoint =
    (await validEntrypoint(root, feature.entrypoints[0]?.path, allowedFiles)) ??
    ownedFiles[0]?.path ??
    null;
  if (entrypoint === null) {
    return null;
  }
  const firstEntry = feature.entrypoints[0] ?? null;
  const reason = feature.reason.trim();
  return {
    title: feature.title,
    summary:
      reason.length > 0 ? `${feature.summary}\n\nAgent mapper reason: ${reason}` : feature.summary,
    kind: feature.kind,
    source: "agent-mapper",
    confidence: feature.confidence,
    entryPath: entrypoint,
    identityKey: agentIdentityKey(entrypoint, ownedFiles),
    symbol: firstEntry?.symbol ?? null,
    route: firstEntry?.route ?? null,
    command: firstEntry?.command ?? null,
    ownedFiles,
    contextFiles,
    tests,
    tags: uniqueStrings(["agent-mapped", ...feature.tags]),
    trustBoundaries: feature.trustBoundaries,
    skipNearbyTests: true,
  };
}

function uniqueSeeds(seeds: FeatureSeed[]): FeatureSeed[] {
  const seen = new Set<string>();
  const output: FeatureSeed[] = [];
  for (const seed of seeds) {
    const key = [
      seed.kind,
      seed.source,
      seed.entryPath,
      seed.identityKey ?? seed.command ?? seed.route ?? seed.symbol ?? "",
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(seed);
  }
  return output;
}

function agentIdentityKey(entrypoint: string, ownedFiles: SeedFileRef[]): string {
  return uniqueStrings([entrypoint, ...ownedFiles.map((file) => file.path)])
    .toSorted()
    .join("|");
}

function mergeMapResults(
  heuristic: MapResult,
  agent: MapResult,
  existing: FeatureRecord[],
): MapResult {
  const byId = new Map<string, FeatureRecord>();
  for (const feature of heuristic.features) {
    byId.set(feature.featureId, feature);
  }
  for (const feature of agent.features) {
    byId.set(feature.featureId, feature);
  }
  const features = [...byId.values()];
  const existingById = new Map(existing.map((feature) => [feature.featureId, feature]));
  return {
    features,
    created: features.filter((feature) => !existingById.has(feature.featureId)).length,
    changed: features.filter((feature) => {
      const previous = existingById.get(feature.featureId);
      return previous !== undefined && stableFeatureJson(previous) !== stableFeatureJson(feature);
    }).length,
    stale: existing.filter((feature) => !byId.has(feature.featureId)).length,
  };
}

function stableFeatureJson(feature: FeatureRecord): string {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    lock: _lock,
    analysisHistory: _analysisHistory,
    ...stable
  } = feature;
  return JSON.stringify(stable);
}

async function validFileRefs(
  root: string,
  refs: SeedFileRef[],
  allowedFiles: ReadonlySet<string>,
  limit: number,
): Promise<SeedFileRef[]> {
  const output: SeedFileRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const path = normalize(ref.path);
    if (seen.has(path) || !allowedFiles.has(path) || !(await validRelativeFile(root, path))) {
      continue;
    }
    seen.add(path);
    output.push({ path, reason: ref.reason });
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

async function validTests(
  root: string,
  refs: SeedTestRef[],
  allowedFiles: ReadonlySet<string>,
  limit: number,
): Promise<SeedTestRef[]> {
  const files = await validFileRefs(
    root,
    refs.map((ref) => ({ path: ref.path, reason: "agent mapper test" })),
    allowedFiles,
    limit,
  );
  return files.map((file) => ({ path: file.path, command: null }));
}

async function validEntrypoint(
  root: string,
  path: string | undefined,
  allowedFiles: ReadonlySet<string>,
): Promise<string | null> {
  if (path === undefined) {
    return null;
  }
  const normalized = normalize(path);
  if (!allowedFiles.has(normalized)) {
    return null;
  }
  return (await validRelativeFile(root, normalized)) ? normalized : null;
}

async function validRelativeFile(root: string, path: string): Promise<boolean> {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0")) {
    return false;
  }
  return isSafeFile(root, join(root, path));
}

async function repoInventory(
  root: string,
  project: ProjectRecord,
  features: FeatureRecord[],
  filters: PathFilters | undefined,
): Promise<RepoInventory> {
  const skipPath = await inventorySkipPath(root, project, features);
  const files = applyPathFilters(
    ((await gitInventoryFiles(root)) ?? (await walk(root, [""], skipPath))).filter(
      (path) => !skipPath(path),
    ),
    filters,
  );
  const sourceFiles = files.filter(isSourceFile).filter((path) => !isTestFile(path));
  const testFiles = files.filter(isTestFile);
  const ownedSource = new Set(
    features.flatMap((feature) => feature.ownedFiles.map((file) => file.path)).filter(isSourceFile),
  );
  const ownedSourceFiles = sourceFiles.filter((file) => ownedSource.has(file)).length;
  const sourceCoverage =
    sourceFiles.length === 0 ? 1 : Number((ownedSourceFiles / sourceFiles.length).toFixed(3));
  const weak = weakMap(features, sourceFiles.length, sourceCoverage);
  return {
    files: files.length,
    sourceFiles: sourceFiles.length,
    testFiles: testFiles.length,
    ownedSourceFiles,
    sourceCoverage,
    weak: weak.weak,
    weakReason: weak.reason,
    allFiles: new Set(files),
    manifests: files.filter(isManifestFile),
    topLevelDirs: uniqueStrings(files.map((file) => file.split("/")[0] ?? "").filter(Boolean)),
    fileSamples: files.slice(0, 400),
    sourceFileSamples: sourceFiles.slice(0, 500),
    testFileSamples: testFiles.slice(0, 200),
  };
}

async function gitInventoryFiles(root: string): Promise<string[] | null> {
  const result = await runCommandArgs(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    root,
    undefined,
    { trimOutput: false },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const paths = uniqueStrings(
    result.stdout
      .split("\0")
      .map((path) => normalize(path).replace(/\\/gu, "/"))
      .filter(isInventoryPath),
  );
  const existing = await Promise.all(
    paths.map(async (path) => ((await pathExists(join(root, path))) ? path : null)),
  );
  return existing.filter((path): path is string => path !== null);
}

function isInventoryPath(path: string): boolean {
  return (
    path.length > 0 && !isAbsolute(path) && !path.includes("\0") && !path.split("/").includes("..")
  );
}

async function inventorySkipPath(
  root: string,
  project: ProjectRecord,
  features: FeatureRecord[],
): Promise<(path: string) => boolean> {
  if (
    (await pathExists(join(root, "mix.exs"))) ||
    hasDependencySkippingProject(project) ||
    hasDependencySkippingFeatures(features)
  ) {
    return shouldSkipDependencyPath;
  }
  return shouldSkip;
}

function hasDependencySkippingProject(project: ProjectRecord): boolean {
  return (
    project.detected.languages.some((language) => language === "c" || language === "cpp") ||
    project.detected.packageManagers.some(
      (manager) => manager === "cmake" || manager === "autotools",
    )
  );
}

function hasDependencySkippingFeatures(features: FeatureRecord[]): boolean {
  return features.some(
    (feature) =>
      feature.tags.some((tag) => tag === "c" || tag === "cpp") ||
      ["autotools-bin", "autotools-lib", "cmake-bin", "cmake-lib", "cmake-test", "c-main"].includes(
        feature.source,
      ),
  );
}

function shouldSkipDependencyPath(path: string): boolean {
  return shouldSkip(path) || /(^|\/)deps(\/|$)/u.test(path);
}

function weakMap(
  features: FeatureRecord[],
  sourceFileCount: number,
  sourceCoverage: number,
): { weak: boolean; reason: string } {
  const meaningful = features.filter((feature) => feature.kind !== "config");
  if (features.length === 0) {
    return { weak: true, reason: "heuristic mapper produced no features" };
  }
  if (sourceFileCount > 0 && meaningful.length === 0) {
    return { weak: true, reason: "heuristic mapper produced only config features" };
  }
  if (sourceFileCount >= 4 && sourceCoverage < 0.25) {
    return {
      weak: true,
      reason: `heuristic map covers ${Math.round(sourceCoverage * 100)}% of source files`,
    };
  }
  if (sourceFileCount >= 12 && meaningful.length <= 2) {
    return { weak: true, reason: "heuristic mapper produced too few meaningful features" };
  }
  return { weak: false, reason: "heuristic map is meaningful" };
}

function inventorySummary(inventory: RepoInventory): RepoInventorySummary {
  const { files, sourceFiles, testFiles, ownedSourceFiles, sourceCoverage, weak, weakReason } =
    inventory;
  return { files, sourceFiles, testFiles, ownedSourceFiles, sourceCoverage, weak, weakReason };
}

function isSourceFile(path: string): boolean {
  const ext = /\.[^.]+$/u.exec(path)?.[0]?.toLowerCase();
  return ext !== undefined && sourceExtensions.has(ext);
}

function isManifestFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return manifestNames.has(name) || /\.(?:sln|slnx|csproj|fsproj|vbproj)$/iu.test(name);
}

function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|(?:^|[._-])(?:test|spec)\.[^/]+$/iu.test(path);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
