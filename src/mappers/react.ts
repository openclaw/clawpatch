import { readFileSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pathExists } from "../fs.js";
import {
  detectNodePackageManager,
  isSafeDirectory,
  isSampleProjectPath,
  nodeScriptCommand,
  normalize,
  pathMatchesPrefix,
  pathInsideRoot,
  shouldSkip,
  walk,
} from "./shared.js";
import { projectTargetCommand } from "./projects.js";
import {
  FeatureSeed,
  MapperContext,
  SeedFileRef,
  SeedTestRef,
  suppressedTestCommandTag,
} from "./types.js";
import type { NodeProjectInfo } from "./projects.js";
import type { WorkspaceTaskGraph } from "./task-graph.js";

type PackageJson = {
  name?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
  scripts?: unknown;
};

type ReactPackage = {
  root: string;
  packageJsonPath: string;
  packageJson: PackageJson;
  packageManager: string;
  testCommand: string | null;
  suppressConfiguredTest: boolean;
};

type RouteMatch = {
  path: string;
  component: string;
  declarationPath: string;
};

type RouteDeclaration = {
  path: string;
  component: string | null;
};

const lazyImportRe =
  /const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)\s*\)/gu;
const defaultImportRe =
  /import\s+([A-Z][A-Za-z0-9_]*)(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/gu;
const namedImportRe = /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/gu;
const anyImportRe = /(?:import\s+["']([^"']+)["']|from\s+["']([^"']+)["'])/gu;
const packageRootCandidates = ["", "frontend", "client", "web", "ui", "app", "apps", "packages"];
const sourceRoots = ["src", "app"];
const componentRoots = ["src/pages", "src/components"];
const testRoots = ["src", "app", "test", "tests", "__tests__", "e2e"];
const contextImportExtensions = new Set([
  ".css",
  ".js",
  ".jsx",
  ".json",
  ".less",
  ".md",
  ".mdx",
  ".mjs",
  ".sass",
  ".scss",
  ".svg",
  ".ts",
  ".tsx",
]);

export async function reactSeeds(root: string, context: MapperContext): Promise<FeatureSeed[]> {
  syncFileCache.clear();
  const packages = await discoverReactPackages(root, context.projects, context.taskGraph);
  const seeds: FeatureSeed[] = [];
  for (const info of packages) {
    seeds.push(...(await routeSeeds(root, info)));
    seeds.push(...(await componentSeeds(root, info, seeds)));
  }
  return seeds;
}

async function routeSeeds(root: string, info: ReactPackage): Promise<FeatureSeed[]> {
  const files = await packageSourceFiles(root, info, sourceRoots);
  const routeFiles = files
    .filter((file) => /\.(tsx|jsx|ts|js)$/u.test(file))
    .filter((file) => !isJsTestPath(file));
  const testCommand = packageTestCommand(info);
  const tests = await packageTestFiles(root, info);
  const seeds: FeatureSeed[] = [];

  for (const file of routeFiles) {
    const source = await readFile(join(root, file), "utf8");
    const parsedSource = stripJsxComments(source);
    const routeTagNames = reactRouterRouteTagNames(parsedSource);
    if (routeTagNames.size === 0) {
      continue;
    }
    const routes = routeMatches(parsedSource, file, routeTagNames);
    if (routes.length === 0) {
      continue;
    }
    const imports = componentImports(root, file, parsedSource);
    for (const route of routes) {
      if (isFrameworkRouteComponent(route.component)) {
        continue;
      }
      const entryPath = imports.get(route.component) ?? route.declarationPath;
      const routeTests = associatedTests([entryPath], tests, testCommand);
      seeds.push({
        title: `React route ${route.path}`,
        summary: `React Router route '${route.path}' rendered by ${route.component}.`,
        kind: "route",
        source: "react-router-route",
        confidence: entryPath === route.declarationPath ? "medium" : "high",
        entryPath,
        symbol: route.component,
        route: route.path,
        command: null,
        ownedFiles:
          entryPath === route.declarationPath
            ? [{ path: route.declarationPath, reason: "route declaration" }]
            : [{ path: entryPath, reason: "route component" }],
        contextFiles: uniqueFileRefs([
          { path: info.packageJsonPath, reason: "package manifest" },
          ...(entryPath === route.declarationPath
            ? []
            : [{ path: route.declarationPath, reason: "route declaration" }]),
          ...directImportRefs(root, entryPath),
          ...routeTests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests: routeTests,
        tags: [
          "react",
          "react-router",
          "web",
          ...(info.suppressConfiguredTest ? [suppressedTestCommandTag] : []),
        ],
        trustBoundaries: ["user-input", "network", "serialization"],
        skipNearbyTests: true,
      });
    }
  }
  return seeds;
}

function isFrameworkRouteComponent(component: string): boolean {
  return new Set(["Navigate", "Outlet"]).has(component);
}

async function componentSeeds(
  root: string,
  info: ReactPackage,
  existingSeeds: FeatureSeed[],
): Promise<FeatureSeed[]> {
  const routeOwnedFiles = new Set(
    existingSeeds
      .filter((seed) => seed.source === "react-router-route")
      .flatMap((seed) => (seed.ownedFiles ?? [{ path: seed.entryPath }]).map((file) => file.path)),
  );
  const files = await packageSourceFiles(root, info, componentRoots);
  const componentFiles = files
    .filter(isReactComponentFile)
    .filter((file) => !routeOwnedFiles.has(file))
    .slice(0, 100);
  const testCommand = packageTestCommand(info);
  const tests = await packageTestFiles(root, info);

  return componentFiles.map((file) => {
    const componentName = basename(file).replace(/\.[^.]+$/u, "");
    const componentTests = associatedTests([file], tests, testCommand);
    return {
      title: `React component ${componentName}`,
      summary: `React component implemented by ${file}.`,
      kind: "ui-flow",
      source: "react-component",
      confidence: "medium",
      entryPath: file,
      symbol: componentName,
      route: null,
      command: null,
      ownedFiles: [{ path: file, reason: "component implementation" }],
      contextFiles: uniqueFileRefs([
        { path: info.packageJsonPath, reason: "package manifest" },
        ...directImportRefs(root, file),
        ...componentTests.map((test) => ({ path: test.path, reason: "associated test" })),
      ]),
      tests: componentTests,
      tags: [
        "react",
        "component",
        "web",
        ...(info.suppressConfiguredTest ? [suppressedTestCommandTag] : []),
      ],
      trustBoundaries: ["user-input", "network", "serialization"],
      skipNearbyTests: true,
    };
  });
}

async function discoverReactPackages(
  root: string,
  projects: NodeProjectInfo[],
  taskGraph: WorkspaceTaskGraph,
): Promise<ReactPackage[]> {
  const packages: ReactPackage[] = [];
  const rootPackageManager = await detectNodePackageManager(root);
  for (const packageJsonPath of await packageJsonPaths(root)) {
    const packageJson = await readPackageJsonAt(root, packageJsonPath);
    if (packageJson === null || !hasReactDependency(packageJson)) {
      continue;
    }
    const packageRoot = dirname(packageJsonPath) === "." ? "." : dirname(packageJsonPath);
    const project = projects.find((candidate) => candidate.root === packageRoot);
    const packageManager =
      project?.packageManager ??
      (await packageManagerForReactPackage(root, packageRoot, rootPackageManager));
    const projectTestCommand =
      project === undefined ? undefined : projectTargetCommand(project, "test", taskGraph);
    packages.push({
      root: packageRoot,
      packageJsonPath,
      packageJson,
      packageManager,
      testCommand:
        projectTestCommand !== undefined
          ? projectTestCommand
          : packageJsonTestCommand(packageJson, packageManager, packageRoot),
      suppressConfiguredTest: projectTestCommand === null,
    });
  }
  return packages;
}

async function packageManagerForReactPackage(
  root: string,
  packageRoot: string,
  fallback: string,
): Promise<string> {
  if (packageRoot === "." || !(await hasPackageManagerMarker(root, packageRoot))) {
    return fallback;
  }
  return detectNodePackageManager(join(root, packageRoot));
}

async function hasPackageManagerMarker(root: string, packageRoot: string): Promise<boolean> {
  return (
    (await pathExists(join(root, packageRoot, "pnpm-lock.yaml"))) ||
    (await pathExists(join(root, packageRoot, "pnpm-workspace.yaml"))) ||
    (await pathExists(join(root, packageRoot, "package-lock.json"))) ||
    (await pathExists(join(root, packageRoot, "yarn.lock"))) ||
    (await pathExists(join(root, packageRoot, "bun.lockb")))
  );
}

async function packageJsonPaths(root: string): Promise<string[]> {
  const paths = new Set<string>();
  const patterns = await workspacePatterns(root);
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .flatMap((pattern) => {
      const normalized = normalizeWorkspacePattern(pattern.slice(1));
      return normalized === null ? [] : [normalized];
    });
  for (const candidate of packageRootCandidates) {
    const packageJsonPath = candidate === "" ? "package.json" : `${candidate}/package.json`;
    if (
      !isExcludedWorkspace(candidate === "" ? "." : candidate, excludes) &&
      (await pathExists(join(root, packageJsonPath)))
    ) {
      paths.add(packageJsonPath);
    }
  }
  for (const path of await fallbackPackageJsonPaths(root)) {
    const packageRoot = dirname(path);
    if (!isExcludedWorkspace(packageRoot, excludes)) {
      paths.add(path);
    }
  }
  for (const path of await workspacePackageJsonPaths(root, patterns, excludes)) {
    paths.add(path);
  }
  return [...paths].toSorted();
}

async function fallbackPackageJsonPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const prefix of ["apps", "packages", "frontend", "client", "web"]) {
    await collectPackageJsonPaths(root, prefix, 4, paths);
  }
  return paths.toSorted();
}

async function collectPackageJsonPaths(
  root: string,
  prefix: string,
  remainingDepth: number,
  paths: string[],
): Promise<void> {
  if (remainingDepth < 0 || shouldSkip(prefix) || isSampleProjectPath(prefix)) {
    return;
  }
  if (await pathExists(join(root, prefix, "package.json"))) {
    paths.push(`${prefix}/package.json`);
  }
  if (remainingDepth === 0) {
    return;
  }
  for (const entry of await safeDirectoryEntries(root, prefix)) {
    await collectPackageJsonPaths(root, `${prefix}/${entry}`, remainingDepth - 1, paths);
  }
}

async function workspacePatterns(root: string): Promise<string[]> {
  const patterns = new Set<string>();
  const rootPackage = await readPackageJsonAt(root, "package.json");
  if (rootPackage !== null) {
    for (const pattern of packageWorkspacePatterns(rootPackage)) {
      patterns.add(pattern);
    }
  }
  if (await pathExists(join(root, "pnpm-workspace.yaml"))) {
    for (const pattern of parsePnpmWorkspace(
      await readFile(join(root, "pnpm-workspace.yaml"), "utf8"),
    )) {
      patterns.add(pattern);
    }
  }
  return [...patterns];
}

async function workspacePackageJsonPaths(
  root: string,
  patterns: string[],
  excludes: string[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const pattern of patterns.filter((entry) => !entry.startsWith("!"))) {
    for (const packageRoot of await expandWorkspacePattern(root, pattern)) {
      if (!isExcludedWorkspace(packageRoot, excludes)) {
        paths.push(packageRelativePath(packageRoot, "package.json"));
      }
    }
  }
  return paths;
}

function packageWorkspacePatterns(pkg: PackageJson): string[] {
  const workspaces = (pkg as { workspaces?: unknown }).workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === "string");
  }
  if (
    typeof workspaces === "object" &&
    workspaces !== null &&
    Array.isArray((workspaces as { packages?: unknown }).packages)
  ) {
    return (workspaces as { packages: unknown[] }).packages.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return [];
}

function parsePnpmWorkspace(source: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/#.*/u, "");
    if (/^\S/u.test(line)) {
      inPackages = /^packages\s*:/u.test(line);
    }
    if (!inPackages) {
      continue;
    }
    const match = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      patterns.push(match[1]);
    }
  }
  return patterns;
}

async function expandWorkspacePattern(root: string, pattern: string): Promise<string[]> {
  const normalized = normalizeWorkspacePattern(pattern);
  if (normalized === null) {
    return [];
  }
  if (normalized === "." || normalized === "") {
    return ["."];
  }
  if (normalized.endsWith("/*")) {
    const parent = normalized.slice(0, -2);
    if (hasWorkspaceGlob(parent)) {
      return expandWorkspaceGlob(root, normalized);
    }
    const packageRoots = (await safeDirectoryEntries(root, parent)).map(
      (entry) => `${parent}/${entry}`,
    );
    const existing: string[] = [];
    for (const packageRoot of packageRoots) {
      if (await pathExists(join(root, packageRoot, "package.json"))) {
        existing.push(packageRoot);
      }
    }
    return existing;
  }
  if (hasWorkspaceGlob(normalized)) {
    return expandWorkspaceGlob(root, normalized);
  }
  return (await pathExists(join(root, normalized, "package.json"))) ? [normalized] : [];
}

function normalizeWorkspacePattern(pattern: string): string | null {
  const normalized = normalize(pattern)
    .replace(/^\.\//u, "")
    .replace(/\/package\.json$/u, "")
    .replace(/\/$/u, "");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return null;
  }
  return normalized;
}

function isExcludedWorkspace(packageRoot: string, excludes: string[]): boolean {
  return excludes.some((pattern) => workspacePatternMatches(pattern, packageRoot));
}

function workspacePatternMatches(pattern: string, packageRoot: string): boolean {
  if (pattern === packageRoot) {
    return true;
  }
  if (hasWorkspaceGlob(pattern)) {
    return workspaceGlobMatches(pattern, packageRoot);
  }
  if (pattern.endsWith("/**")) {
    return pathMatchesPrefix(packageRoot, pattern.slice(0, -3));
  }
  if (pattern.endsWith("/*")) {
    const parent = pattern.slice(0, -2);
    if (!pathMatchesPrefix(packageRoot, parent)) {
      return false;
    }
    return packageRoot.slice(parent.length + 1).split("/").length === 1;
  }
  return false;
}

async function expandWorkspaceGlob(root: string, pattern: string): Promise<string[]> {
  const packages: string[] = [];

  async function visit(base: string, remaining: string[]): Promise<void> {
    if (shouldSkip(base)) {
      return;
    }
    const [segment, ...rest] = remaining;
    if (segment === undefined) {
      if (base.length > 0 && (await pathExists(join(root, base, "package.json")))) {
        packages.push(base);
      }
      return;
    }
    if (!hasWorkspaceGlob(segment)) {
      await visit(base.length === 0 ? segment : `${base}/${segment}`, rest);
      return;
    }
    if (segment === "**") {
      await visit(base, rest);
      for (const entry of await safeDirectoryEntries(root, base)) {
        const child = base.length === 0 ? entry : `${base}/${entry}`;
        if (!shouldSkip(child)) {
          await visit(child, remaining);
        }
      }
      return;
    }
    const matcher = globSegmentRegExp(segment);
    for (const entry of await safeDirectoryEntries(root, base)) {
      const child = base.length === 0 ? entry : `${base}/${entry}`;
      if (matcher.test(entry) && !shouldSkip(child)) {
        await visit(child, rest);
      }
    }
  }

  await visit("", pattern.split("/"));
  return packages.toSorted();
}

async function safeDirectoryEntries(root: string, prefix: string): Promise<string[]> {
  const dir = join(root, prefix);
  if (!(await isSafeDirectory(root, dir))) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .toSorted();
}

function hasWorkspaceGlob(pattern: string): boolean {
  return /[*?]/u.test(pattern);
}

function workspaceGlobMatches(pattern: string, packageRoot: string): boolean {
  return globSegmentsMatch(pattern.split("/"), packageRoot.split("/"));
}

function globSegmentsMatch(pattern: string[], candidate: string[]): boolean {
  const [segment, ...remainingPattern] = pattern;
  if (segment === undefined) {
    return candidate.length === 0;
  }
  if (segment === "**") {
    return (
      globSegmentsMatch(remainingPattern, candidate) ||
      (candidate.length > 0 && globSegmentsMatch(pattern, candidate.slice(1)))
    );
  }
  const [candidateSegment, ...remainingCandidate] = candidate;
  if (candidateSegment === undefined || !globSegmentRegExp(segment).test(candidateSegment)) {
    return false;
  }
  return globSegmentsMatch(remainingPattern, remainingCandidate);
}

function globSegmentRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")}$`, "u");
}

function hasReactDependency(pkg: PackageJson): boolean {
  return (
    dependencyFieldHas(pkg.dependencies, "react") ||
    dependencyFieldHas(pkg.devDependencies, "react") ||
    dependencyFieldHas(pkg.peerDependencies, "react") ||
    dependencyFieldHas(pkg.optionalDependencies, "react")
  );
}

function dependencyFieldHas(field: unknown, name: string): boolean {
  return typeof field === "object" && field !== null && Object.hasOwn(field, name);
}

async function packageSourceFiles(
  root: string,
  info: ReactPackage,
  prefixes: string[],
): Promise<string[]> {
  return (
    await walk(
      root,
      prefixes.map((prefix) => packageRelativePath(info.root, prefix)),
    )
  )
    .filter((file) => pathMatchesPrefix(file, info.root === "." ? "" : info.root))
    .filter(isReviewableReactSourceFile);
}

async function packageTestFiles(root: string, info: ReactPackage): Promise<string[]> {
  return (
    await walk(
      root,
      testRoots.map((prefix) => packageRelativePath(info.root, prefix)),
    )
  )
    .filter(isJsTestPath)
    .slice(0, 200);
}

function routeMatches(
  source: string,
  declarationPath: string,
  routeTagNames: ReadonlySet<string>,
): RouteMatch[] {
  const routes: RouteMatch[] = [];
  for (const route of routeDeclarations(source, routeTagNames)) {
    if (route.component === null) {
      continue;
    }
    routes.push({ path: route.path, component: route.component, declarationPath });
  }
  return routes;
}

function routeDeclarations(source: string, routeTagNames: ReadonlySet<string>): RouteDeclaration[] {
  const routes: RouteDeclaration[] = [];
  const pathStack: Array<string | null> = [];
  const strippedSource = stripJsxComments(source);
  const tagPattern = routeTagPattern(routeTagNames);
  for (const match of strippedSource.matchAll(tagPattern)) {
    if (isInsideJsString(strippedSource, match.index)) {
      continue;
    }
    if (match[0].startsWith("</")) {
      pathStack.pop();
      continue;
    }
    const tagName = match[1] ?? match[2];
    if (tagName === undefined) {
      continue;
    }
    const tag = readRouteTag(strippedSource, match.index + 1 + tagName.length);
    if (tag === null) {
      continue;
    }
    const declaredPath = topLevelPropValue(tag.props, "path") ?? undefined;
    const hasPathProp = topLevelPropExists(tag.props, "path");
    const indexProp = topLevelPropValue(tag.props, "index");
    const isIndexRoute = indexProp === null || indexProp === "true";
    const parentPath = pathStack.length === 0 ? "" : (pathStack[pathStack.length - 1] ?? null);
    const path = reactRoutePath(parentPath, declaredPath, hasPathProp, isIndexRoute);
    if (path !== null && (declaredPath !== undefined || isIndexRoute)) {
      routes.push({ path, component: routeElementComponent(tag.props) });
    }
    if (!tag.selfClosing) {
      pathStack.push(path);
    }
  }
  return routes;
}

function reactRoutePath(
  parentPath: string | null,
  declaredPath: string | undefined,
  hasPathProp: boolean,
  isIndexRoute: boolean,
): string | null {
  if (parentPath === null) {
    return null;
  }
  if (declaredPath !== undefined) {
    return joinReactRoutePaths(parentPath, declaredPath);
  }
  if (hasPathProp) {
    return null;
  }
  return isIndexRoute ? parentPath || "/" : parentPath;
}

function reactRouterRouteTagNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /import\s+\{([^}]+)\}\s+from\s+["']react-router(?:-dom)?["']/gu,
  )) {
    if (isInsideJsString(source, match.index)) {
      continue;
    }
    const imports = match[1];
    if (imports === undefined) {
      continue;
    }
    for (const item of imports.split(",")) {
      const importMatch = /^\s*Route(?:\s+as\s+([A-Z][A-Za-z0-9_]*))?\s*$/u.exec(item);
      if (importMatch !== null) {
        names.add(importMatch[1] ?? "Route");
      }
    }
  }
  return names;
}

function routeTagPattern(routeTagNames: ReadonlySet<string>): RegExp {
  const names = [...routeTagNames].map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`</(${names.join("|")})\\s*>|<(${names.join("|")})\\b`, "gu");
}

function routeElementComponent(props: string): string | null {
  const element = readJsxExpressionProp(props, "element");
  if (element === undefined) {
    return null;
  }
  const expression = unwrapParenthesizedExpression(element.trim());
  if (!expression.startsWith("<")) {
    return conditionalElementComponent(expression);
  }
  const root = readJsxOpeningTag(expression, 0);
  if (root === null) {
    return null;
  }
  let current = root;
  while (!current.selfClosing && isRouteWrapperComponent(current.name)) {
    const child = readJsxOpeningTag(expression, current.end);
    if (child === null) {
      break;
    }
    current = child;
  }
  return current.name;
}

function unwrapParenthesizedExpression(expression: string): string {
  let current = expression;
  while (current.startsWith("(") && current.endsWith(")")) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function conditionalElementComponent(expression: string): string | null {
  if (!expression.includes("?") || !expression.includes(":")) {
    return null;
  }
  const candidates = new Set(
    jsxOpeningTagNames(expression).filter(
      (name) => !isFrameworkRouteComponent(name) && !isRouteWrapperComponent(name),
    ),
  );
  return candidates.size === 1 ? ([...candidates][0] ?? null) : null;
}

function jsxOpeningTagNames(source: string): string[] {
  const names: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const openIndex = source.indexOf("<", cursor);
    if (openIndex === -1) {
      break;
    }
    if (source[openIndex + 1] === "/") {
      cursor = openIndex + 2;
      continue;
    }
    const tag = readJsxOpeningTag(source, openIndex);
    if (tag === null) {
      cursor = openIndex + 1;
      continue;
    }
    names.push(tag.name);
    cursor = tag.end;
  }
  return names;
}

function topLevelPropValue(props: string, name: string): string | null | undefined {
  return readTopLevelProp(props, name)?.value;
}

function topLevelPropExists(props: string, name: string): boolean {
  return readTopLevelProp(props, name) !== undefined;
}

function readTopLevelProp(
  props: string,
  name: string,
): { value: string | null | undefined } | undefined {
  let braceDepth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < props.length; index += 1) {
    const char = props[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth === 0 && propNameMatchesAt(props, name, index)) {
      return { value: readTopLevelPropValue(props, index + name.length) };
    }
  }
  return undefined;
}

function propNameMatchesAt(source: string, name: string, index: number): boolean {
  return (
    source.slice(index, index + name.length) === name &&
    !/[A-Za-z0-9_-]/u.test(source[index - 1] ?? "") &&
    !/[A-Za-z0-9_-]/u.test(source[index + name.length] ?? "")
  );
}

function readTopLevelPropValue(props: string, index: number): string | null | undefined {
  let cursor = index;
  while (/\s/u.test(props[cursor] ?? "")) {
    cursor += 1;
  }
  if (props[cursor] !== "=") {
    return null;
  }
  cursor += 1;
  while (/\s/u.test(props[cursor] ?? "")) {
    cursor += 1;
  }
  const quote = props[cursor];
  if (quote === '"' || quote === "'") {
    const end = props.indexOf(quote, cursor + 1);
    return end === -1 ? "" : props.slice(cursor + 1, end);
  }
  if (props[cursor] === "{") {
    const end = props.indexOf("}", cursor + 1);
    if (end === -1) {
      return undefined;
    }
    const expression = props.slice(cursor + 1, end).trim();
    if (expression === "true") {
      return "true";
    }
    const stringMatch = /^(["'])(.*)\1$/su.exec(expression);
    return stringMatch?.[2];
  }
  return null;
}

function readJsxExpressionProp(props: string, propName: string): string | undefined {
  const start = topLevelExpressionPropStart(props, propName);
  if (start === undefined) {
    return undefined;
  }
  let depth = 1;
  let quote: string | null = null;
  let escaped = false;
  for (let index = start; index < props.length; index += 1) {
    const char = props[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return props.slice(start, index);
      }
    }
  }
  return undefined;
}

function topLevelExpressionPropStart(props: string, name: string): number | undefined {
  let braceDepth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < props.length; index += 1) {
    const char = props[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth !== 0 || !propNameMatchesAt(props, name, index)) {
      continue;
    }
    let cursor = index + name.length;
    while (/\s/u.test(props[cursor] ?? "")) {
      cursor += 1;
    }
    if (props[cursor] !== "=") {
      return undefined;
    }
    cursor += 1;
    while (/\s/u.test(props[cursor] ?? "")) {
      cursor += 1;
    }
    return props[cursor] === "{" ? cursor + 1 : undefined;
  }
  return undefined;
}

function readJsxOpeningTag(
  source: string,
  start: number,
): { name: string; end: number; selfClosing: boolean } | null {
  const openIndex = source.indexOf("<", start);
  if (openIndex === -1 || source[openIndex + 1] === "/") {
    return null;
  }
  const name =
    source[openIndex + 1] === ">"
      ? "Fragment"
      : /^<([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)(?=[\s/>])/u.exec(
          source.slice(openIndex),
        )?.[1];
  if (name === undefined) {
    return null;
  }
  let braceDepth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      braceDepth += 1;
    } else if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (char === ">" && braceDepth === 0) {
      return {
        name,
        end: index + 1,
        selfClosing: source.slice(openIndex, index).trimEnd().endsWith("/"),
      };
    }
  }
  return null;
}

function isRouteWrapperComponent(name: string): boolean {
  const component = name.split(".").at(-1) ?? name;
  return new Set([
    "Fragment",
    "Suspense",
    "RequireAuth",
    "ProtectedRoute",
    "PrivateRoute",
    "AuthGuard",
  ]).has(component);
}

function stripJsxComments(source: string): string {
  return stripBlockComments(source).split("\n").map(stripLineComment).join("\n");
}

function stripLineComment(line: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }
  return line;
}

function stripBlockComments(source: string): string {
  let output = "";
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      output += char;
      continue;
    }
    if (source.startsWith("{/*", index)) {
      const end = source.indexOf("*/}", index + 3);
      const close = end === -1 ? source.length : end + 3;
      output += blankComment(source.slice(index, close));
      index = close - 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const close = end === -1 ? source.length : end + 2;
      output += blankComment(source.slice(index, close));
      index = close - 1;
      continue;
    }
    output += char;
  }
  return output;
}

function blankComment(source: string): string {
  return source.replace(/[^\n]/gu, " ");
}

function readRouteTag(
  source: string,
  start: number,
): { props: string; selfClosing: boolean } | null {
  let braceDepth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      braceDepth += 1;
    } else if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (char === ">" && braceDepth === 0) {
      const props = source.slice(start, index);
      return { props, selfClosing: props.trimEnd().endsWith("/") };
    }
  }
  return null;
}

function joinReactRoutePaths(parent: string, child: string): string {
  if (child.startsWith("/")) {
    return child;
  }
  if (child.length === 0) {
    return parent.length === 0 ? "/" : parent;
  }
  if (parent.length === 0 || parent === "/") {
    return `/${child.replace(/^\//u, "")}`;
  }
  return `${parent.replace(/\/$/u, "")}/${child.replace(/^\//u, "")}`;
}

function componentImports(root: string, fromPath: string, source: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(lazyImportRe)) {
    const component = match[1];
    const importPath = match[2];
    if (
      component === undefined ||
      importPath === undefined ||
      isInsideJsString(source, match.index)
    ) {
      continue;
    }
    const resolved = resolveImport(root, fromPath, importPath);
    if (resolved !== null) {
      imports.set(component, resolved);
    }
  }
  for (const match of source.matchAll(defaultImportRe)) {
    const component = match[1];
    const importPath = match[2];
    if (
      component === undefined ||
      importPath === undefined ||
      isInsideJsString(source, match.index)
    ) {
      continue;
    }
    const resolved = resolveImport(root, fromPath, importPath);
    if (resolved !== null) {
      imports.set(component, resolved);
    }
  }
  for (const match of source.matchAll(namedImportRe)) {
    const importList = match[1];
    const importPath = match[2];
    if (
      importList === undefined ||
      importPath === undefined ||
      isInsideJsString(source, match.index)
    ) {
      continue;
    }
    const resolved = resolveImport(root, fromPath, importPath);
    if (resolved === null) {
      continue;
    }
    for (const component of importedNames(importList)) {
      imports.set(component, resolved);
    }
  }
  return imports;
}

function importedNames(importList: string): string[] {
  return importList
    .split(",")
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      const alias = /\bas\s+([A-Z][A-Za-z0-9_]*)$/u.exec(entry)?.[1];
      const name = /^([A-Z][A-Za-z0-9_]*)/u.exec(entry)?.[1];
      return alias ?? name ?? [];
    });
}

function directImportRefs(root: string, path: string): SeedFileRef[] {
  const fullPath = join(root, path);
  if (!pathExistsSyncMemo(fullPath)) {
    return [];
  }
  const rawSource = readFileSyncMemo(fullPath);
  if (rawSource === null) {
    return [];
  }
  const source = stripJsxComments(rawSource);
  const refs: SeedFileRef[] = [];
  for (const match of source.matchAll(anyImportRe)) {
    const importPath = match[1] ?? match[2];
    if (
      importPath === undefined ||
      !importPath.startsWith(".") ||
      isInsideJsString(source, match.index)
    ) {
      continue;
    }
    const resolved = resolveImport(root, path, importPath);
    if (resolved !== null) {
      refs.push({ path: resolved, reason: "direct import" });
    }
  }
  return uniqueFileRefs(refs);
}

function isInsideJsString(source: string, offset: number): boolean {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < offset; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if ((char === '"' || char === "'" || char === "`") && !isLikelyJsxTextQuote(source, index)) {
      quote = char;
    }
  }
  return quote !== null;
}

function isLikelyJsxTextQuote(source: string, index: number): boolean {
  const lastTagEnd = source.lastIndexOf(">", index);
  if (lastTagEnd === -1 || source.lastIndexOf("<", index) > lastTagEnd) {
    return false;
  }
  return !source.slice(lastTagEnd + 1, index).includes("{");
}

const syncFileCache = new Map<string, string | null>();

function pathExistsSyncMemo(path: string): boolean {
  return readFileSyncMemo(path) !== null;
}

function readFileSyncMemo(path: string): string | null {
  if (syncFileCache.has(path)) {
    return syncFileCache.get(path) ?? null;
  }
  try {
    const source = readFileSync(path, "utf8");
    syncFileCache.set(path, source);
    return source;
  } catch {
    syncFileCache.set(path, null);
    return null;
  }
}

function resolveImport(root: string, fromPath: string, importPath: string): string | null {
  if (!importPath.startsWith(".")) {
    return null;
  }
  const base = join(dirname(fromPath), importPath);
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    `${base}.css`,
    join(base, "index.tsx"),
    join(base, "index.ts"),
    join(base, "index.jsx"),
    join(base, "index.js"),
  ];
  for (const candidate of candidates.map(normalize).filter(isTextContextImportCandidate)) {
    const fullPath = join(root, candidate);
    if (
      !shouldSkip(candidate) &&
      pathInsideRoot(root, fullPath) &&
      realPathInsideRoot(root, fullPath) &&
      pathExistsSyncMemo(fullPath)
    ) {
      return candidate;
    }
  }
  return null;
}

function isTextContextImportCandidate(path: string): boolean {
  const extension = extname(path);
  return extension.length === 0 || contextImportExtensions.has(extension);
}

function realPathInsideRoot(root: string, path: string): boolean {
  try {
    return pathInsideRoot(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
}

function associatedTests(files: string[], tests: string[], command: string | null): SeedTestRef[] {
  const dirs = new Set(files.map((file) => dirname(file)));
  const exact = tests.filter((test) => files.some((file) => isExactTestForFile(file, test)));
  const nearby = tests.filter(
    (test) => !exact.includes(test) && [...dirs].some((dir) => pathMatchesPrefix(test, dir)),
  );
  return [...exact, ...nearby].slice(0, 8).map((path) => ({ path, command }));
}

function isExactTestForFile(file: string, test: string): boolean {
  const fileStem = basename(file).replace(/\.[^.]+$/u, "");
  const testStem = basename(test).replace(/\.(test|spec)\.[^.]+$/u, "");
  if (fileStem !== testStem) {
    return false;
  }
  return fileStem !== "index" || dirname(file) === dirname(test);
}

function packageTestCommand(info: ReactPackage): string | null {
  return info.testCommand;
}

function packageJsonTestCommand(
  packageJson: PackageJson,
  packageManager: string,
  packageRoot: string,
): string | null {
  if (!packageScripts(packageJson).has("test")) {
    return null;
  }
  return nodeScriptCommand(packageManager, packageRoot, "test");
}

function packageScripts(pkg: PackageJson): Set<string> {
  if (typeof pkg.scripts !== "object" || pkg.scripts === null) {
    return new Set();
  }
  return new Set(
    Object.entries(pkg.scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([script]) => script),
  );
}

function isReviewableReactSourceFile(path: string): boolean {
  return (
    /\.(tsx|jsx|ts|js)$/u.test(path) &&
    !isJsTestPath(path) &&
    !/\.d\.[cm]?ts$/u.test(path) &&
    !isReactSupportPath(path)
  );
}

function isReactComponentFile(path: string): boolean {
  return /\.(tsx|jsx)$/u.test(path) && isReviewableReactSourceFile(path);
}

function isReactSupportPath(path: string): boolean {
  return (
    /(^|\/)(\.storybook|stories|__stories__)(\/|$)/u.test(path) ||
    /(^|\/)(fixtures|__fixtures__|testdata)(\/|$)/u.test(path) ||
    /\.(stories|story)\.[^.]+$/u.test(path)
  );
}

function isJsTestPath(path: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(path);
}

function packageRelativePath(packageRoot: string, path: string): string {
  return packageRoot === "." ? normalize(path) : normalize(join(packageRoot, path));
}

async function readPackageJsonAt(root: string, path: string): Promise<PackageJson | null> {
  if (!(await safeFile(root, path))) {
    return null;
  }
  const parsed: unknown = JSON.parse(await readFile(join(root, path), "utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
}

async function safeFile(root: string, path: string): Promise<boolean> {
  const fullPath = join(root, path);
  if (shouldSkip(path) || !(await pathExists(fullPath)) || !realPathInsideRoot(root, fullPath)) {
    return false;
  }
  const info = await lstat(fullPath);
  return info.isFile() && !info.isSymbolicLink();
}

function uniqueFileRefs(refs: SeedFileRef[]): SeedFileRef[] {
  const seen = new Set<string>();
  const output: SeedFileRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.path)) {
      continue;
    }
    seen.add(ref.path);
    output.push(ref);
  }
  return output;
}
