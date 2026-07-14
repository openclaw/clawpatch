import { FeatureRecord, TrustBoundary } from "../types.js";
import type { NodeProjectInfo } from "./projects.js";
import type { WorkspaceTaskGraph } from "./task-graph.js";
import type { VfsCache } from "./vfs-cache.js";

export type SeedFileRef = {
  path: string;
  reason: string;
};

export type SeedTestRef = {
  path: string;
  command: string | null;
};

export type FeatureSeed = {
  title: string;
  summary: string;
  kind: FeatureRecord["kind"];
  source: string;
  confidence: FeatureRecord["confidence"];
  entryPath: string;
  identityKey?: string;
  symbol: string | null;
  route: string | null;
  command: string | null;
  tags: string[];
  trustBoundaries: TrustBoundary[];
  ownedFiles?: SeedFileRef[];
  contextFiles?: SeedFileRef[];
  tests?: SeedTestRef[];
  testCommand?: string | null;
  testPrefixes?: string[];
  skipNearbyTests?: boolean;
};

export const suppressedTestCommandTag = "validation:test-suppressed";

export type FeatureMapper = {
  name: string;
  usesNodeContext?: boolean;
  map(root: string, context: MapperContext): Promise<FeatureSeed[]>;
};

export type MapperContext = {
  nodeProjects(): Promise<NodeProjectInfo[]>;
  nodeTaskGraph(): Promise<WorkspaceTaskGraph>;
  vfs: VfsCache;
};
