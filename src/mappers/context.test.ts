import { describe, expect, it, vi } from "vitest";
import { createMapperContext } from "./context.js";
import { emptyTaskGraph } from "./task-graph.js";
import type { RootFileInventory } from "./types.js";

const emptyRootFileInventory = async (): Promise<RootFileInventory> => new Map();

describe("createMapperContext", () => {
  it("shares concurrent first access across all Node consumers", async () => {
    const projects: [] = [];
    const graph = emptyTaskGraph();
    const discoverNodeProjects = vi.fn(async () => projects);
    const buildNodeTaskGraph = vi.fn(async () => graph);
    const context = createMapperContext({
      discoverNodeProjects,
      buildNodeTaskGraph,
      buildRootFileInventory: emptyRootFileInventory,
    });

    const results = await Promise.all([
      context.nodeProjects(),
      context.nodeProjects(),
      context.nodeTaskGraph(),
      context.nodeTaskGraph(),
    ]);

    expect(results).toEqual([projects, projects, graph, graph]);
    expect(discoverNodeProjects).toHaveBeenCalledTimes(1);
    expect(buildNodeTaskGraph).toHaveBeenCalledTimes(1);
    expect(buildNodeTaskGraph).toHaveBeenCalledWith(projects);
  });

  it("shares project discovery failures without starting the task graph", async () => {
    const failure = new Error("project discovery failed");
    const discoverNodeProjects = vi.fn(async () => {
      throw failure;
    });
    const buildNodeTaskGraph = vi.fn(async () => emptyTaskGraph());
    const context = createMapperContext({
      discoverNodeProjects,
      buildNodeTaskGraph,
      buildRootFileInventory: emptyRootFileInventory,
    });

    const results = await Promise.allSettled([
      context.nodeProjects(),
      context.nodeProjects(),
      context.nodeTaskGraph(),
    ]);

    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(discoverNodeProjects).toHaveBeenCalledTimes(1);
    expect(buildNodeTaskGraph).not.toHaveBeenCalled();
  });

  it("shares task graph failures", async () => {
    const failure = new Error("task graph failed");
    const discoverNodeProjects = vi.fn(async () => []);
    const buildNodeTaskGraph = vi.fn(async () => {
      throw failure;
    });
    const context = createMapperContext({
      discoverNodeProjects,
      buildNodeTaskGraph,
      buildRootFileInventory: emptyRootFileInventory,
    });

    const results = await Promise.allSettled([context.nodeTaskGraph(), context.nodeTaskGraph()]);

    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(discoverNodeProjects).toHaveBeenCalledTimes(1);
    expect(buildNodeTaskGraph).toHaveBeenCalledTimes(1);
  });

  it("invalidates memoized data with each mapping context", async () => {
    const discoverNodeProjects = vi.fn(async () => []);
    const buildNodeTaskGraph = vi.fn(async () => emptyTaskGraph());

    await createMapperContext({
      discoverNodeProjects,
      buildNodeTaskGraph,
      buildRootFileInventory: emptyRootFileInventory,
    }).nodeTaskGraph();
    await createMapperContext({
      discoverNodeProjects,
      buildNodeTaskGraph,
      buildRootFileInventory: emptyRootFileInventory,
    }).nodeTaskGraph();

    expect(discoverNodeProjects).toHaveBeenCalledTimes(2);
    expect(buildNodeTaskGraph).toHaveBeenCalledTimes(2);
  });

  it("shares one root-file inventory across concurrent mapper consumers", async () => {
    const goFiles = ["fallback.go"];
    const cCppFiles = ["main.cpp"];
    const dotnetFiles = ["Program.cs"];
    const buildRootFileInventory = vi.fn(
      async (): Promise<RootFileInventory> =>
        new Map([
          ["go-fallback", goFiles],
          ["c-cpp", cCppFiles],
          ["dotnet", dotnetFiles],
        ]),
    );
    const context = createMapperContext({
      discoverNodeProjects: async () => [],
      buildNodeTaskGraph: async () => emptyTaskGraph(),
      buildRootFileInventory,
    });

    const results = await Promise.all([
      context.rootFiles("go-fallback"),
      context.rootFiles("c-cpp"),
      context.rootFiles("dotnet"),
    ]);

    expect(results).toEqual([goFiles, cCppFiles, dotnetFiles]);
    expect(buildRootFileInventory).toHaveBeenCalledTimes(1);
  });
});
