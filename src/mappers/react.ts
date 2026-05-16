import { readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../fs.js";
import {
  detectNodePackageManager,
  isSampleProjectPath,
  nodeScriptCommand,
  normalize,
  pathMatchesPrefix,
  shouldSkip,
  walk,
} from "./shared.js";
import { FeatureSeed, SeedFileRef, SeedTestRef } from "./types.js";

type PackageJson = {
  name?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
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

const routePathPropRe = /\bpath=(["'])(.*?)\1/su;
const routeElementPropRe = /\belement=\{\s*<([A-Z][A-Za-z0-9_]*)/su;
const lazyImportRe =
  /const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)\s*\)/gu;
const defaultImportRe = /import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+["']([^"']+)["']/gu;
const namedImportRe = /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/gu;
const anyImportRe = /from\s+["']([^"']+)["']/gu;

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
  const routeFiles = files.filter((file) => /\.(tsx|jsx|ts|js)$/u.test(file));
  const testCommand = packageTestCommand(info);
  const tests = await packageTestFiles(root, info);
  const seeds: FeatureSeed[] = [];

  for (const file of routeFiles) {
    const source = await readFile(join(root, file), "utf8");
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
  return new Set(["Navigate", "Outlet", "Fragment", "Suspense"]).has(component);
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
  const packageManager = await detectNodePackageManager(root);
  for (const packageJsonPath of await packageJsonPaths(root)) {
    const packageJson = await readPackageJsonAt(root, packageJsonPath);
    if (packageJson === null || !hasReactDependency(packageJson)) {
      continue;
    }
    packages.push({
      root: dirname(packageJsonPath) === "." ? "." : dirname(packageJsonPath),
      packageJsonPath,
      packageJson,
      packageManager,
    });
  }
  return packages;
}

async function packageJsonPaths(root: string): Promise<string[]> {
  const paths = new Set<string>();
  for (const candidate of packageRootCandidates) {
    const packageJsonPath = candidate === "" ? "package.json" : `${candidate}/package.json`;
    if (await pathExists(join(root, packageJsonPath))) {
      paths.add(packageJsonPath);
    }
  }
  for (const path of (await walk(root, ["apps", "packages", "frontend", "client", "web"])).filter(
    (file) => file.endsWith("/package.json") && !isSampleProjectPath(file),
  )) {
    paths.add(path);
  }
  return [...paths].toSorted();
}

function hasReactDependency(pkg: PackageJson): boolean {
  return (
    dependencyFieldHas(pkg.dependencies, "react") ||
    dependencyFieldHas(pkg.devDependencies, "react")
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
  for (const props of routeTagProps(source)) {
    const path = routePathPropRe.exec(props)?.[2];
    const component = routeElementPropRe.exec(props)?.[1];
    if (path === undefined || component === undefined) {
      continue;
    }
    routes.push({ path, component, declarationPath });
  }
  return routes;
}

function routeTagProps(source: string): string[] {
  const props: string[] = [];
  for (const match of source.matchAll(/<Route\b/gu)) {
    const start = match.index + "<Route".length;
    let braceDepth = 0;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") {
        braceDepth += 1;
      } else if (char === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (char === ">" && braceDepth === 0) {
        props.push(source.slice(start, index));
        break;
      }
    }
  }
  return props;
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
    if (!shouldSkip(candidate) && pathExistsSyncMemo(join(root, candidate))) {
      return candidate;
    }
  }
  return null;
}

function associatedTests(files: string[], tests: string[], command: string | null): SeedTestRef[] {
  const fileStems = new Set(files.map((file) => basename(file).replace(/\.[^.]+$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  return tests
    .filter((test) => {
      const testStem = basename(test).replace(/\.(test|spec)\.[^.]+$/u, "");
      return fileStems.has(testStem) || [...dirs].some((dir) => pathMatchesPrefix(test, dir));
    })
    .slice(0, 8)
    .map((path) => ({ path, command }));
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
