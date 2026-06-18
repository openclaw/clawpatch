import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageScripts } from "../detect.js";
import { pathExists } from "../fs.js";
import { shellQuotePath } from "../shell.js";
import { detectNodePackageManager, type NodeProjectInfo } from "./projects.js";
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
  const rootPackageManager = await detectNodePackageManager(root);
  const graph: WorkspaceTaskGraph = {
    runner: "turbo",
    globalDependencies: stringArray(parsed.globalDependencies),
    globalEnv: stringArray(parsed.globalEnv),
    commands: [],
  };

  for (const project of projects) {
    const scripts = packageScripts(project.packageJson);
    const packageName = turboPackageName(project);
    for (const task of validationTaskNames) {
      if (
        project.root === "." ||
        !project.workspaceMember ||
        scripts[task] === undefined ||
        !hasTaskEntry(taskEntries, packageName, task)
      ) {
        continue;
      }
      const metadata = metadataForTask(taskEntries, packageName, task);
      graph.commands.push({
        projectRoot: project.root,
        projectName: project.name,
        task,
        command: metadata.persistent
          ? null
          : turboCommand(rootPackageManager, task, turboFilter(project, packageName)),
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

function hasTaskEntry(
  entries: Map<string, unknown>,
  packageName: string | null,
  task: string,
): boolean {
  return (packageName !== null && entries.has(`${packageName}#${task}`)) || entries.has(task);
}

function metadataForTask(
  entries: Map<string, unknown>,
  packageName: string | null,
  task: string,
): WorkspaceTaskMetadata {
  return taskMetadata(
    (packageName === null ? undefined : entries.get(`${packageName}#${task}`)) ?? entries.get(task),
  );
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

function turboCommand(packageManager: string, task: string, filter: string): string {
  const quotedTask = shellQuotePath(task);
  const quotedFilter = shellQuotePath(filter);
  if (packageManager === "pnpm") {
    return `pnpm turbo run ${quotedTask} --filter ${quotedFilter}`;
  }
  if (packageManager === "yarn") {
    return `yarn turbo run ${quotedTask} --filter ${quotedFilter}`;
  }
  if (packageManager === "bun") {
    return `bunx turbo run ${quotedTask} --filter ${quotedFilter}`;
  }
  return `npx turbo run ${quotedTask} --filter ${quotedFilter}`;
}

function turboPackageName(project: NodeProjectInfo): string | null {
  const packageName = project.packageJson?.name;
  if (typeof packageName === "string" && packageName.length > 0) {
    return packageName;
  }
  return null;
}

function turboFilter(project: NodeProjectInfo, packageName: string | null): string {
  if (packageName !== null) {
    return packageName;
  }
  return `./${project.root}`;
}
