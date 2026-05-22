import { chunkFiles, partitionFileGroups } from "./grouping.js";
import { isCOrCppPath, isCOrCppTestPath, languageTag, withCudaConcurrency } from "./shared.js";
import { FeatureSeed } from "./types.js";

const sourceGroupMaxFiles = 12;

export function cCppGroupSeeds(sourceFiles: string[], ownedPaths: Set<string>): FeatureSeed[] {
  const residual = sourceFiles.filter(
    (path) => isCOrCppPath(path) && !ownedPaths.has(path) && !isCOrCppTestPath(path),
  );
  if (residual.length === 0) {
    return [];
  }
  const byTopDir = new Map<string, string[]>();
  for (const path of residual) {
    const slash = path.indexOf("/");
    const topDir = slash === -1 ? "" : path.slice(0, slash);
    byTopDir.set(topDir, [...(byTopDir.get(topDir) ?? []), path]);
  }
  const seeds: FeatureSeed[] = [];
  for (const [topDir, files] of [...byTopDir.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const groups =
      topDir === ""
        ? chunkFiles(".", files.toSorted(), sourceGroupMaxFiles)
        : partitionFileGroups(topDir, files, sourceGroupMaxFiles);
    for (const group of groups) {
      seeds.push(groupSeed(group.label, group.files));
    }
  }
  return seeds;
}

function groupSeed(label: string, files: string[]): FeatureSeed {
  const sorted = files.toSorted();
  const tags = [...new Set(sorted.map(languageTag))];
  const isCuda = tags.includes("cuda");
  return {
    title: `${isCuda ? "CUDA" : "C/C++"} source group ${label}`,
    summary: `C/C++/CUDA source files under ${label} not owned by a build target.`,
    kind: "library",
    source: "c-cpp-group",
    confidence: "low",
    entryPath: sorted[0] ?? label,
    symbol: label,
    route: null,
    command: null,
    tags: [...tags, "source-group"],
    trustBoundaries: withCudaConcurrency(["filesystem"], isCuda ? "cuda" : "cpp"),
    ownedFiles: sorted.map((path) => ({ path, reason: "source group member" })),
  };
}
