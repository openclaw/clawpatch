import type { NodeProjectInfo } from "./projects.js";
import type { WorkspaceTaskGraph } from "./task-graph.js";
import type { MapperContext } from "./types.js";

export type MapperContextLoaders = {
  discoverNodeProjects(): Promise<NodeProjectInfo[]>;
  buildNodeTaskGraph(projects: NodeProjectInfo[]): Promise<WorkspaceTaskGraph>;
};

export function createMapperContext(loaders: MapperContextLoaders): MapperContext {
  const nodeProjects = memoizeAsync(loaders.discoverNodeProjects);
  const nodeTaskGraph = memoizeAsync(async () => loaders.buildNodeTaskGraph(await nodeProjects()));
  return { nodeProjects, nodeTaskGraph };
}

function memoizeAsync<T>(loader: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= Promise.resolve().then(loader);
    return promise;
  };
}
