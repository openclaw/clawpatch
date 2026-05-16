import { readFileSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../fs.js";
import {
  detectNodePackageManager,
  isSampleProjectPath,
  nodeScriptCommand,
  normalize,
  pathMatchesPrefix,
  pathInsideRoot,
  shouldSkip,
  walk,
} from "./shared.js";
import { FeatureSeed, SeedFileRef, SeedTestRef } from "./types.js";

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

const routePathPropRe = /\bpath=(["'])(.*?)\1/su;
const lazyImportRe =
  /const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)\s*\)/gu;
const defaultImportRe =
  /import\s+([A-Z][A-Za-z0-9_]*)(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/gu;
const namedImportRe = /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/gu;
const anyImportRe = /from\s+["']([^"']+)["']/gu;
const reactRouterRouteImportRe =
  /import\s+\{[^}]*\bRoute\b[^}]*\}\s+from\s+["']react-router(?:-dom)?["']/u;

const packageRootCandidates = ["", "frontend", "client", "web", "ui", "app", "apps", "packages"];
const sourceRoots = ["src", "app"];
const componentRoots = ["src/pages", "src/components"];
const testRoots = ["src", "test", "tests", "__tests__", "e2e"];

export async function reactSeeds(root: string): Promise<FeatureSeed[]> {
  const packages = await discoverReactPackages(root);
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
    if (!reactRouterRouteImportRe.test(source)) {
      continue;
    }
    const routes = routeMatches(source, file);
    if (routes.length === 0) {
      continue;
    }
    const imports = componentImports(root, file, source);
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
        tags: ["react", "react-router", "web"],
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
      tags: ["react", "component", "web"],
      trustBoundaries: ["user-input", "network", "serialization"],
      skipNearbyTests: true,
    };
  });
}

async function discoverReactPackages(root: string): Promise<ReactPackage[]> {
  const packages: ReactPackage[] = [];
  const rootPackageManager = await detectNodePackageManager(root);
  for (const packageJsonPath of await packageJsonPaths(root)) {
    const packageJson = await readPackageJsonAt(root, packageJsonPath);
    if (packageJson === null || !hasReactDependency(packageJson)) {
      continue;
    }
    const packageRoot = dirname(packageJsonPath) === "." ? "." : dirname(packageJsonPath);
    packages.push({
      root: packageRoot,
      packageJsonPath,
      packageJson,
      packageManager: await packageManagerForReactPackage(root, packageRoot, rootPackageManager),
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
  if (patterns.length === 0) {
    for (const path of (await walk(root, ["apps", "packages", "frontend", "client", "web"])).filter(
      (file) => file.endsWith("/package.json") && !isSampleProjectPath(file),
    )) {
      paths.add(path);
    }
  }
  for (const path of await workspacePackageJsonPaths(root, patterns, excludes)) {
    paths.add(path);
  }
  return [...paths].toSorted();
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
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
    const packageRoots = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
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
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
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
  ).filter((file) => pathMatchesPrefix(file, info.root === "." ? "" : info.root));
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

function routeMatches(source: string, declarationPath: string): RouteMatch[] {
  const routes: RouteMatch[] = [];
  for (const route of routeDeclarations(source)) {
    if (route.component === null) {
      continue;
    }
    routes.push({ path: route.path, component: route.component, declarationPath });
  }
  return routes;
}

function routeDeclarations(source: string): RouteDeclaration[] {
  const routes: RouteDeclaration[] = [];
  const pathStack: string[] = [];
  const strippedSource = stripJsxComments(source);
  for (const match of strippedSource.matchAll(/<\/Route\s*>|<Route\b/gu)) {
    if (match[0].startsWith("</")) {
      pathStack.pop();
      continue;
    }
    const tag = readRouteTag(strippedSource, match.index + "<Route".length);
    if (tag === null) {
      continue;
    }
    const declaredPath = routePathPropRe.exec(tag.props)?.[2];
    const isIndexRoute = hasIndexRouteProp(tag.props);
    const parentPath = pathStack.at(-1) ?? "";
    const path =
      declaredPath === undefined
        ? isIndexRoute
          ? parentPath || "/"
          : parentPath
        : joinReactRoutePaths(parentPath, declaredPath);
    if (declaredPath !== undefined || isIndexRoute) {
      routes.push({ path, component: routeElementComponent(tag.props) });
    }
    if (!tag.selfClosing) {
      pathStack.push(path);
    }
  }
  return routes;
}

function hasIndexRouteProp(props: string): boolean {
  return /(?:^|\s)index(?:\s*=\s*\{?\s*true\s*\}?|(?=\s|$))/su.test(props);
}

function routeElementComponent(props: string): string | null {
  const element = readJsxExpressionProp(props, "element");
  if (element === undefined) {
    return null;
  }
  const components = [...element.matchAll(/<([A-Z][A-Za-z0-9_]*)(?=[\s/>])/gu)]
    .map((match) => match[1])
    .filter((component): component is string => component !== undefined);
  return components.at(-1) ?? null;
}

function readJsxExpressionProp(props: string, propName: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${propName}\\s*=\\s*\\{`, "u").exec(props);
  if (match === null) {
    return undefined;
  }
  let depth = 1;
  let quote: string | null = null;
  let escaped = false;
  const start = match.index + match[0].length;
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

function stripJsxComments(source: string): string {
  return source
    .split("\n")
    .map(stripLineComment)
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "");
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

function readRouteTag(
  source: string,
  start: number,
): { props: string; selfClosing: boolean } | null {
  let braceDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
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
    if (component === undefined || importPath === undefined) {
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
    if (component === undefined || importPath === undefined) {
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
    if (importList === undefined || importPath === undefined) {
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
  const source = readFileSyncMemo(fullPath);
  if (source === null) {
    return [];
  }
  const refs: SeedFileRef[] = [];
  for (const match of source.matchAll(anyImportRe)) {
    const importPath = match[1];
    if (importPath === undefined || !importPath.startsWith(".")) {
      continue;
    }
    const resolved = resolveImport(root, path, importPath);
    if (resolved !== null) {
      refs.push({ path: resolved, reason: "direct import" });
    }
  }
  return uniqueFileRefs(refs);
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
  for (const candidate of candidates.map(normalize)) {
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

function realPathInsideRoot(root: string, path: string): boolean {
  try {
    return pathInsideRoot(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
}

function associatedTests(files: string[], tests: string[], command: string | null): SeedTestRef[] {
  const fileStems = new Set(files.map((file) => basename(file).replace(/\.[^.]+$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  const exact = tests.filter((test) =>
    fileStems.has(basename(test).replace(/\.(test|spec)\.[^.]+$/u, "")),
  );
  const nearby = tests.filter(
    (test) => !exact.includes(test) && [...dirs].some((dir) => pathMatchesPrefix(test, dir)),
  );
  return [...exact, ...nearby].slice(0, 8).map((path) => ({ path, command }));
}

function packageTestCommand(info: ReactPackage): string | null {
  if (!packageScripts(info.packageJson).has("test")) {
    return null;
  }
  return nodeScriptCommand(info.packageManager, info.root, "test");
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

function isReactComponentFile(path: string): boolean {
  return /\.(tsx|jsx)$/u.test(path) && !isJsTestPath(path) && !/\.d\.[cm]?ts$/u.test(path);
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
  if (shouldSkip(path) || !(await pathExists(join(root, path)))) {
    return false;
  }
  const info = await lstat(join(root, path));
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
