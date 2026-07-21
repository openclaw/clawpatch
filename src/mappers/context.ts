import type { NodeProjectInfo } from "./projects.js";
import type { WorkspaceTaskGraph } from "./task-graph.js";
import type { MapperContext, RootFileInventory } from "./types.js";

export type MapperContextLoaders = {
  discoverNodeProjects(): Promise<NodeProjectInfo[]>;
  buildNodeTaskGraph(projects: NodeProjectInfo[]): Promise<WorkspaceTaskGraph>;
  buildRootFileInventory(): Promise<RootFileInventory>;
};

export function createMapperContext(loaders: MapperContextLoaders): MapperContext {
  const nodeProjects = memoizeAsync(loaders.discoverNodeProjects);
  const nodeTaskGraph = memoizeAsync(async () => loaders.buildNodeTaskGraph(await nodeProjects()));
  const rootFileInventory = memoizeAsync(loaders.buildRootFileInventory);
  const rootFiles: MapperContext["rootFiles"] = async (policy) =>
    (await rootFileInventory()).get(policy) ?? [];
  return { nodeProjects, nodeTaskGraph, rootFiles };
}

function memoizeAsync<T>(loader: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= Promise.resolve().then(loader);
    return promise;
  };
}
