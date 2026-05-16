import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageScripts } from "../detect.js";
import { pathExists } from "../fs.js";
import type { NodeProjectInfo } from "./projects.js";
import {
  emptyTaskGraph,
  validationTaskNames,
  type WorkspaceTaskGraph,
  type WorkspaceTaskMetadata,
} from "./task-graph.js";

type TurboConfig = {
  globalDependencies?: unknown;
  globalEnv?: unknown;
  tasks?: unknown;
  pipeline?: unknown;
};

const emptyTaskMetadata: WorkspaceTaskMetadata = {
  dependsOn: [],
  outputs: [],
  env: [],
  cache: null,
  persistent: false,
};

export async function turboTaskGraph(
  root: string,
  projects: NodeProjectInfo[],
): Promise<WorkspaceTaskGraph> {
  const path = join(root, "turbo.json");
  if (!(await pathExists(path))) {
    return emptyTaskGraph();
  }

  const parsed = JSON.parse(await readFile(path, "utf8")) as TurboConfig;
  const taskEntries = taskRecord(parsed.tasks ?? parsed.pipeline);
  const graph: WorkspaceTaskGraph = {
    runner: "turbo",
    globalDependencies: stringArray(parsed.globalDependencies),
    globalEnv: stringArray(parsed.globalEnv),
    commands: [],
  };

  for (const project of projects) {
    const scripts = packageScripts(project.packageJson);
    for (const task of validationTaskNames) {
      if (scripts[task] === undefined || !hasTaskEntry(taskEntries, project.name, task)) {
        continue;
      }
      const metadata = metadataForTask(taskEntries, project.name, task);
      if (metadata.persistent) {
        continue;
      }
      graph.commands.push({
        projectRoot: project.root,
        projectName: project.name,
        task,
        command: turboCommand(project.packageManager, task, project.name, project.root),
        metadata,
      });
    }
  }

  return graph;
}

function taskRecord(value: unknown): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Map();
  }
  return new Map(Object.entries(value));
}

function hasTaskEntry(entries: Map<string, unknown>, projectName: string, task: string): boolean {
  return entries.has(`${projectName}#${task}`) || entries.has(task);
}

function metadataForTask(
  entries: Map<string, unknown>,
  projectName: string,
  task: string,
): WorkspaceTaskMetadata {
  return taskMetadata(entries.get(`${projectName}#${task}`) ?? entries.get(task));
}

function taskMetadata(value: unknown): WorkspaceTaskMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...emptyTaskMetadata };
  }
  const record = value as {
    dependsOn?: unknown;
    outputs?: unknown;
    env?: unknown;
    cache?: unknown;
    persistent?: unknown;
  };
  return {
    dependsOn: stringArray(record.dependsOn),
    outputs: stringArray(record.outputs),
    env: stringArray(record.env),
    cache: typeof record.cache === "boolean" ? record.cache : null,
    persistent: record.persistent === true,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function turboCommand(
  packageManager: string,
  task: string,
  projectName: string,
  projectRoot: string,
): string {
  const filter = projectName.length > 0 ? projectName : projectRoot;
  if (packageManager === "pnpm") {
    return `pnpm turbo run ${task} --filter ${filter}`;
  }
  if (packageManager === "yarn") {
    return `yarn turbo run ${task} --filter ${filter}`;
  }
  if (packageManager === "bun") {
    return `bunx turbo run ${task} --filter ${filter}`;
  }
  return `npx turbo run ${task} --filter ${filter}`;
}
