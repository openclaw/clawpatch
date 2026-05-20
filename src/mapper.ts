import { nowIso } from "./fs.js";
import { stableId } from "./id.js";
import { cCppSeeds } from "./mappers/c-cpp.js";
import { configSeeds } from "./mappers/config.js";
import { dotnetSeeds } from "./mappers/dotnet.js";
import { elixirSeeds } from "./mappers/elixir.js";
import { goSeeds } from "./mappers/go.js";
import { appleSeeds } from "./mappers/apple.js";
import { gradleSeeds } from "./mappers/gradle.js";
import { laravelSeeds } from "./mappers/laravel.js";
import { mavenSeeds } from "./mappers/maven.js";
import { nextSeeds } from "./mappers/next.js";
import { nodeRouteSeeds } from "./mappers/node-routes.js";
import { nodeSeeds } from "./mappers/node.js";
import { pythonSeeds } from "./mappers/python.js";
import { reactSeeds } from "./mappers/react.js";
import { discoverNodeProjects } from "./mappers/projects.js";
import { rubySeeds } from "./mappers/ruby.js";
import { rustSeeds } from "./mappers/rust.js";
import { nearbyTests, PathFilters, pathMatchesFilters } from "./mappers/shared.js";
import { swiftSeeds } from "./mappers/swift.js";
import { turboTaskGraph } from "./mappers/turbo.js";
import { FeatureMapper, FeatureSeed, MapperContext } from "./mappers/types.js";
import { FeatureRecord, ProjectRecord } from "./types.js";

export type MapResult = {
  features: FeatureRecord[];
  created: number;
  changed: number;
  stale: number;
};

export type MapProgressEvent = {
  event: "mapper-start" | "mapper-done";
  mapper: string;
  seeds?: number;
  elapsedMs?: number;
};

export type MapOptions = {
  onProgress?: (event: MapProgressEvent) => void;
  filters?: PathFilters;
};

const featureMappers: FeatureMapper[] = [
  { name: "node", map: nodeSeeds },
  { name: "next", map: nextSeeds },
  { name: "react", map: reactSeeds },
  { name: "node-routes", map: nodeRouteSeeds },
  { name: "go", map: goSeeds },
  { name: "python", map: pythonSeeds },
  { name: "ruby", map: rubySeeds },
  { name: "elixir", map: elixirSeeds },
  { name: "rust", map: rustSeeds },
  { name: "dotnet", map: dotnetSeeds },
  { name: "c-cpp", map: cCppSeeds },
  { name: "swift", map: swiftSeeds },
  { name: "apple", map: appleSeeds },
  { name: "gradle", map: gradleSeeds },
  { name: "maven", map: mavenSeeds },
  { name: "laravel", map: laravelSeeds },
  { name: "config", map: configSeeds },
];

export async function mapFeatures(
  root: string,
  project: ProjectRecord,
  existing: FeatureRecord[],
  options: MapOptions = {},
): Promise<MapResult> {
  const seeds = await collectSeeds(root, options);
  return mapFeatureSeeds(root, project, existing, seeds, options);
}

export async function mapFeatureSeeds(
  root: string,
  project: ProjectRecord,
  existing: FeatureRecord[],
  seeds: FeatureSeed[],
  options: MapOptions = {},
): Promise<MapResult> {
  const existingById = new Map(existing.map((feature) => [feature.featureId, feature]));
  const features: FeatureRecord[] = [];
  let created = 0;
  let changed = 0;
  const now = nowIso();
  for (const rawSeed of seeds) {
    const seed = filterSeed(rawSeed, options.filters);
    if (seed === null) {
      continue;
    }
    const identity = featureIdentity(seed, existingById);
    const featureId = identity.featureId;
    const previous = existingById.get(featureId);
    const discoveredTests =
      seed.skipNearbyTests === true
        ? []
        : await nearbyTests(
            root,
            seed.entryPath,
            Object.hasOwn(seed, "testCommand")
              ? (seed.testCommand ?? null)
              : project.detected.commands.test,
            seed.testPrefixes ?? [],
            [seed.command, seed.identityKey].filter(
              (name): name is string => typeof name === "string",
            ),
          );
    const tests = uniqueTests(
      filterTests([...(seed.tests ?? []), ...discoveredTests], options.filters),
    );
    const contextFiles = uniqueFileRefs([
      ...filterFileRefs(seed.contextFiles ?? [], options.filters),
      ...tests.map((test) => ({ path: test.path, reason: "nearby test" })),
    ]);
    const feature: FeatureRecord = {
      schemaVersion: 1,
      featureId,
      title: seed.title,
      summary: seed.summary,
      kind: seed.kind,
      source: seed.source,
      confidence: seed.confidence,
      entrypoints: [
        {
          path: seed.entryPath,
          symbol: identity.symbol,
          route: seed.route,
          command: seed.command,
        },
      ],
      ownedFiles: seed.ownedFiles ?? [{ path: seed.entryPath, reason: "entrypoint" }],
      contextFiles,
      tests,
      tags: seed.tags,
      trustBoundaries: seed.trustBoundaries,
      status: previous?.status ?? "pending",
      lock: previous?.lock ?? null,
      findingIds: previous?.findingIds ?? [],
      patchAttemptIds: previous?.patchAttemptIds ?? [],
      analysisHistory: previous?.analysisHistory ?? [],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const featureChanged =
      previous !== undefined &&
      JSON.stringify(stripVolatile(previous)) !== JSON.stringify(stripVolatile(feature));
    if (featureChanged) {
      feature.status = statusForChangedFeature(previous.status);
    } else if (previous?.status === "skipped") {
      feature.status = "pending";
    }
    if (previous === undefined) {
      created += 1;
    } else if (featureChanged || previous.status === "skipped") {
      changed += 1;
    }
    features.push(feature);
  }
  return {
    features,
    created,
    changed,
    stale: existing.filter(
      (feature) => !features.some((mapped) => mapped.featureId === feature.featureId),
    ).length,
  };
}

function filterSeed(seed: FeatureSeed, filters: PathFilters | undefined): FeatureSeed | null {
  if (filters === undefined) {
    return seed;
  }
  const ownedFiles =
    seed.ownedFiles === undefined ? undefined : filterFileRefs(seed.ownedFiles, filters);
  if (seed.ownedFiles !== undefined && ownedFiles?.length === 0) {
    return null;
  }
  const entryPath = pathMatchesFilters(seed.entryPath, filters)
    ? seed.entryPath
    : (ownedFiles?.[0]?.path ?? null);
  if (entryPath === null) {
    return null;
  }
  const filteredSeed = {
    ...seed,
    entryPath,
    contextFiles: filterFileRefs(seed.contextFiles ?? [], filters),
    tests: filterTests(seed.tests ?? [], filters),
  };
  if (ownedFiles === undefined) {
    return filteredSeed;
  }
  return { ...filteredSeed, ownedFiles };
}

function filterFileRefs(
  refs: Array<{ path: string; reason: string }>,
  filters: PathFilters | undefined,
): Array<{ path: string; reason: string }> {
  if (filters === undefined) {
    return refs;
  }
  return refs.filter((ref) => pathMatchesFilters(ref.path, filters));
}

function filterTests(
  tests: Array<{ path: string; command: string | null }>,
  filters: PathFilters | undefined,
): Array<{ path: string; command: string | null }> {
  if (filters === undefined) {
    return tests;
  }
  return tests.filter((test) => pathMatchesFilters(test.path, filters));
}

function featureIdentity(
  seed: FeatureSeed,
  existingById: Map<string, FeatureRecord>,
): { featureId: string; symbol: string | null } {
  const symbol = effectiveSymbol(seed, existingById);
  return {
    featureId: stableId("feat", [
      seed.kind,
      seed.source,
      seed.entryPath,
      seed.identityKey ?? seed.command ?? seed.route ?? symbol ?? "",
    ]),
    symbol,
  };
}

function effectiveSymbol(
  seed: FeatureSeed,
  existingById: Map<string, FeatureRecord>,
): string | null {
  if (!isDisambiguatedCppLibrary(seed)) {
    return seed.symbol;
  }
  const legacyId = stableId("feat", [seed.kind, seed.source, seed.entryPath, ""]);
  const previous = existingById.get(legacyId);
  if (seed.symbol !== null || previous?.title === seed.title) {
    return previous?.title === seed.title ? null : seed.symbol;
  }
  const previousSymbol = disambiguatorFromTitle(seed.title);
  const previousId = stableId("feat", [seed.kind, seed.source, seed.entryPath, previousSymbol]);
  return existingById.get(previousId)?.title === seed.title ? previousSymbol : null;
}

function isDisambiguatedCppLibrary(seed: FeatureSeed): boolean {
  return seed.kind === "library" && ["cmake-lib", "autotools-lib"].includes(seed.source);
}

function disambiguatorFromTitle(title: string): string {
  return title.split(" ").at(-1) ?? title;
}

function uniqueFileRefs(refs: Array<{ path: string; reason: string }>): Array<{
  path: string;
  reason: string;
}> {
  const seen = new Set<string>();
  const output: Array<{ path: string; reason: string }> = [];
  for (const ref of refs) {
    if (seen.has(ref.path)) {
      continue;
    }
    seen.add(ref.path);
    output.push(ref);
  }
  return output;
}

function uniqueTests(tests: Array<{ path: string; command: string | null }>): Array<{
  path: string;
  command: string | null;
}> {
  const seen = new Set<string>();
  const output: Array<{ path: string; command: string | null }> = [];
  for (const test of tests) {
    if (seen.has(test.path)) {
      continue;
    }
    seen.add(test.path);
    output.push(test);
  }
  return output;
}

async function collectSeeds(root: string, options: MapOptions): Promise<FeatureSeed[]> {
  const projects = await discoverNodeProjects(root);
  const context: MapperContext = {
    projects,
    taskGraph: await turboTaskGraph(root, projects),
  };
  const groups = await Promise.all(
    featureMappers.map(async (mapper) => {
      const started = Date.now();
      options.onProgress?.({ event: "mapper-start", mapper: mapper.name });
      const seeds = await mapper.map(root, context);
      options.onProgress?.({
        event: "mapper-done",
        mapper: mapper.name,
        seeds: seeds.length,
        elapsedMs: Date.now() - started,
      });
      return seeds;
    }),
  );
  return dedupeSeeds(groups.flat());
}

function dedupeSeeds(seeds: FeatureSeed[]): FeatureSeed[] {
  const seen = new Set<string>();
  const output: FeatureSeed[] = [];
  for (const seed of seeds) {
    const key = `${seed.kind}:${seed.source}:${seed.entryPath}:${seed.identityKey ?? seed.command ?? seed.route ?? seed.symbol ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(seed);
  }
  return output;
}

function stripVolatile(
  feature: FeatureRecord,
): Omit<FeatureRecord, "createdAt" | "updatedAt" | "lock" | "analysisHistory"> {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    lock: _lock,
    analysisHistory: _analysisHistory,
    ...stable
  } = feature;
  return stable;
}

function statusForChangedFeature(status: FeatureRecord["status"]): FeatureRecord["status"] {
  if (["reviewed", "revalidated", "fixed", "skipped"].includes(status)) {
    return "pending";
  }
  return status;
}
