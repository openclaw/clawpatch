import { join } from "node:path";
import { pathExists } from "../fs.js";
import {
  dependencyFieldHas,
  packageRelativePath,
  projectContextFiles,
  projectTags,
  projectTargetCommand,
} from "./projects.js";
import { walk } from "./shared.js";
import type { NodeProjectInfo } from "./projects.js";
import type { WorkspaceTaskGraph } from "./task-graph.js";
import { FeatureSeed, MapperContext, suppressedTestCommandTag } from "./types.js";

export async function nextSeeds(root: string, context: MapperContext): Promise<FeatureSeed[]> {
  const seedGroups = await Promise.all(
    context.projects.map(async (project) => projectNextSeeds(root, project, context.taskGraph)),
  );
  return seedGroups.flat();
}

async function projectNextSeeds(
  root: string,
  project: NodeProjectInfo,
  taskGraph: WorkspaceTaskGraph,
): Promise<FeatureSeed[]> {
  const prefixes = await nextPrefixes(root, project);
  if (prefixes.length === 0) {
    return [];
  }
  const files = await walk(root, prefixes);
  const routeFiles = files.flatMap((file) => {
    const projectRelativePath = projectRelativeRoutePath(project, file);
    if (projectRelativePath === null) {
      return [];
    }
    const kind = nextRouteKind(projectRelativePath);
    return kind === null ? [] : [{ file, projectRelativePath, kind }];
  });
  const testCommand = projectTargetCommand(project, "test", taskGraph);
  const contextFiles = await projectContextFiles(root, project);

  return routeFiles.map(({ file, projectRelativePath, kind }) => {
    const route = routeFromProjectFile(projectRelativePath, kind);
    return {
      title: project.root === "." ? `Route ${route}` : `${project.name} route ${route}`,
      summary:
        project.root === "."
          ? `Web route implemented by ${file}.`
          : `Web route implemented by ${file} in project ${project.name}.`,
      kind: "route",
      source: kind === "app" ? "next-app-route" : "next-pages-route",
      confidence: "high",
      entryPath: file,
      symbol: null,
      route,
      command: null,
      contextFiles,
      tags: [
        "next",
        "web",
        ...projectTags(project),
        ...(testCommand === null ? [suppressedTestCommandTag] : []),
      ],
      trustBoundaries: ["user-input", "network", "serialization"],
      ...(testCommand === undefined ? {} : { testCommand }),
    };
  });
}

async function nextPrefixes(root: string, project: NodeProjectInfo): Promise<string[]> {
  const hasSignal = await isNextProject(root, project);
  const projectPrefixes = new Set(
    hasSignal ? ["app", "pages", "src/app", "src/pages"] : ["app", "pages"],
  );
  for (const prefix of sourceRootRoutePrefixes(project)) {
    projectPrefixes.add(prefix);
  }
  const existing: string[] = [];
  for (const prefix of [...projectPrefixes].map((path) =>
    packageRelativePath(project.root, path),
  )) {
    if (await pathExists(join(root, prefix))) {
      existing.push(prefix);
    }
  }
  return existing;
}

function sourceRootRoutePrefixes(project: NodeProjectInfo): string[] {
  const sourceRoot = project.sourceRoot;
  if (sourceRoot === null) {
    return [];
  }
  const relativeSourceRoot =
    project.root === "."
      ? sourceRoot
      : sourceRoot === project.root
        ? ""
        : sourceRoot.startsWith(`${project.root}/`)
          ? sourceRoot.slice(project.root.length + 1)
          : null;
  if (relativeSourceRoot === null) {
    return [];
  }
  return ["app", "pages"].map((path) =>
    relativeSourceRoot.length === 0 ? path : `${relativeSourceRoot}/${path}`,
  );
}

async function isNextProject(root: string, project: NodeProjectInfo): Promise<boolean> {
  const pkg = project.packageJson;
  if (
    dependencyFieldHas(pkg?.dependencies, "next") ||
    dependencyFieldHas(pkg?.devDependencies, "next")
  ) {
    return true;
  }
  for (const file of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    if (await pathExists(join(root, packageRelativePath(project.root, file)))) {
      return true;
    }
  }
  return false;
}

function projectRelativeRoutePath(project: NodeProjectInfo, file: string): string | null {
  if (project.root === ".") {
    return file;
  }
  return file.startsWith(`${project.root}/`) ? file.slice(project.root.length + 1) : null;
}

function nextRouteKind(file: string): "app" | "pages" | null {
  if (
    (file.startsWith("app/") || file.startsWith("src/app/")) &&
    /\/(page|route)\.(tsx|ts|jsx|js)$/u.test(file)
  ) {
    return "app";
  }
  if (/^(src\/)?pages\/.+\.(tsx|ts|jsx|js)$/u.test(file) && !isPagesFrameworkFile(file)) {
    return "pages";
  }
  return null;
}

function isPagesFrameworkFile(file: string): boolean {
  return /^(src\/)?pages\/_(app|document|error)\.(tsx|ts|jsx|js)$/u.test(file);
}

function routeFromProjectFile(file: string, kind: "app" | "pages"): string {
  let route = kind === "app" ? appRouteFromFile(file) : pagesRouteFromFile(file);
  if (route === "") {
    route = "/";
  }
  return route;
}

function appRouteFromFile(file: string): string {
  const normalized = file
    .replace(/^src\//u, "")
    .replace(/^app\//u, "/")
    .replace(/\/(page|route)\.[^.]+$/u, "");
  return normalizeRouteSegments(normalized);
}

function pagesRouteFromFile(file: string): string {
  const normalized = file
    .replace(/^src\//u, "")
    .replace(/^pages\//u, "/")
    .replace(/\.[^.]+$/u, "")
    .replace(/\/index$/u, "");
  return normalizeRouteSegments(normalized);
}

function normalizeRouteSegments(route: string): string {
  const segments = route
    .split("/")
    .filter((segment) => segment.length > 0)
    .filter((segment) => !isRouteGroupSegment(segment))
    .filter((segment) => !segment.startsWith("@"))
    .map(dynamicSegment);
  return `/${segments.join("/")}`.replace(/\/$/u, "");
}

function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")") && !segment.startsWith("(.");
}

function dynamicSegment(segment: string): string {
  const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/u.exec(segment);
  if (optionalCatchAll?.[1] !== undefined) {
    return `:${optionalCatchAll[1]}*`;
  }
  const catchAll = /^\[\.\.\.(.+)\]$/u.exec(segment);
  if (catchAll?.[1] !== undefined) {
    return `:${catchAll[1]}*`;
  }
  const dynamic = /^\[(.+)\]$/u.exec(segment);
  return dynamic?.[1] === undefined ? segment : `:${dynamic[1]}`;
}
