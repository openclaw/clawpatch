import { nowIso } from "./fs.js";
import { stableId } from "./id.js";
import { configSeeds } from "./mappers/config.js";
import { goSeeds } from "./mappers/go.js";
import { appleSeeds } from "./mappers/apple.js";
import { gradleSeeds } from "./mappers/gradle.js";
import { laravelSeeds } from "./mappers/laravel.js";
import { nextSeeds } from "./mappers/next.js";
import { nodeSeeds } from "./mappers/node.js";
import { pythonSeeds } from "./mappers/python.js";
import { reactSeeds } from "./mappers/react.js";
import { discoverNodeProjects } from "./mappers/projects.js";
import { rubySeeds } from "./mappers/ruby.js";
import { rustSeeds } from "./mappers/rust.js";
import { nearbyTests } from "./mappers/shared.js";
import { swiftSeeds } from "./mappers/swift.js";
import { FeatureMapper, FeatureSeed, MapperContext } from "./mappers/types.js";
import { FeatureRecord, ProjectRecord } from "./types.js";

export type MapResult = {
  features: FeatureRecord[];
  created: number;
  changed: number;
  stale: number;
};

const featureMappers: FeatureMapper[] = [
  { name: "node", map: nodeSeeds },
  { name: "next", map: nextSeeds },
  { name: "react", map: reactSeeds },
  { name: "go", map: goSeeds },
  { name: "python", map: pythonSeeds },
  { name: "ruby", map: rubySeeds },
  { name: "rust", map: rustSeeds },
  { name: "swift", map: swiftSeeds },
  { name: "apple", map: appleSeeds },
  { name: "gradle", map: gradleSeeds },
  { name: "laravel", map: laravelSeeds },
  { name: "config", map: configSeeds },
];

export async function mapFeatures(
  root: string,
  project: ProjectRecord,
  existing: FeatureRecord[],
): Promise<MapResult> {
  const seeds = await collectSeeds(root);
  const existingById = new Map(existing.map((feature) => [feature.featureId, feature]));
  const features: FeatureRecord[] = [];
  let created = 0;
  let changed = 0;
  const now = nowIso();
  for (const seed of seeds) {
    const featureId = stableId("feat", [
      seed.kind,
      seed.source,
      seed.entryPath,
      seed.identityKey ?? seed.command ?? seed.route ?? seed.symbol ?? "",
    ]);
    const previous = existingById.get(featureId);
    const discoveredTests =
      seed.skipNearbyTests === true
        ? []
        : await nearbyTests(
            root,
            seed.entryPath,
            seed.testCommand ?? project.detected.commands.test,
            seed.testPrefixes ?? [],
          );
    const tests = uniqueTests([...(seed.tests ?? []), ...discoveredTests]);
    const contextFiles = uniqueFileRefs([
      ...(seed.contextFiles ?? []),
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
          symbol: seed.symbol,
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

async function collectSeeds(root: string): Promise<FeatureSeed[]> {
  const context: MapperContext = {
    projects: await discoverNodeProjects(root),
  };
  const groups = await Promise.all(featureMappers.map((mapper) => mapper.map(root, context)));
  return dedupeSeeds(groups.flat());
}

function dedupeSeeds(seeds: FeatureSeed[]): FeatureSeed[] {
  const seen = new Set<string>();
  const output: FeatureSeed[] = [];
  for (const seed of seeds) {
    const key = `${seed.kind}:${seed.source}:${seed.entryPath}:${seed.command ?? seed.route ?? seed.symbol ?? ""}`;
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
