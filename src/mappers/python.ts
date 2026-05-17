import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../fs.js";
import {
  isSafeDirectory,
  isSafeFile,
  packageKind,
  packageTrustBoundaries,
  pathMatchesPrefix,
  shouldSkip,
  walk,
} from "./shared.js";
import { FeatureSeed, SeedFileRef, SeedTestRef } from "./types.js";

type PythonScript = {
  name: string;
  target: string;
  metadataPath: string;
};

type FlaskRoute = {
  filePath: string;
  functionName: string;
  routePath: string;
  methods: string[];
};

type FastApiRoute = {
  filePath: string;
  functionName: string;
  routePath: string;
  methods: string[];
};

type SourceGroup = {
  label: string;
  files: string[];
};

type PyprojectInfo = {
  name: string | null;
  scripts: PythonScript[];
  hasPytest: boolean;
};

const sourceRoots = ["src", "app", "apps", "lib", "scripts", "web"] as const;
const fastApiRouteTargetPattern = [
  "(?:[A-Za-z_][A-Za-z0-9_]*\\.)*",
  "(?:app|application|api|router|[A-Za-z_][A-Za-z0-9_]*(?:app|api|router))",
].join("");
const fastApiRouteMethods = "api_route|get|post|put|patch|delete|options|head|trace";
const fastApiRouteDecoratorStartPattern = new RegExp(
  `^@${fastApiRouteTargetPattern}\\.(?:${fastApiRouteMethods})\\(`,
  "u",
);
const fastApiRouteDecoratorPattern = new RegExp(
  `^\\s*@${fastApiRouteTargetPattern}\\.(${fastApiRouteMethods})\\((.*)\\)\\s*(?:#.*)?$`,
  "u",
);
const projectMetadataFiles = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
] as const;
const sourceGroupMaxOwnedFiles = 12;
const sourceGroupMaxTests = 8;
const flaskRootEntryFiles = [
  "app.py",
  "wsgi.py",
  "application.py",
  "server.py",
  "main.py",
] as const;

export async function pythonSeeds(root: string): Promise<FeatureSeed[]> {
  if (!(await isPythonProject(root))) {
    return [];
  }
  const metadata = await readPythonProjectMetadata(root);
  const metadataFiles = await pythonMetadataFiles(root);
  const testCommand = await pythonTestCommand(root, metadata);
  const testFiles = await pythonTestFiles(root);
  const seeds: FeatureSeed[] = [];

  if (metadataFiles.length > 0) {
    seeds.push({
      title: `Python project ${metadata.name ?? basename(root)}`,
      summary: `Python project metadata in ${metadataFiles.join(", ")}.`,
      kind: packageKind(metadata.name ?? basename(root)),
      source: "python-project",
      confidence: "medium",
      entryPath: metadataFiles[0] ?? "pyproject.toml",
      symbol: metadata.name,
      route: null,
      command: null,
      ownedFiles: metadataFiles.map((path) => ({ path, reason: "python project metadata" })),
      contextFiles: await pythonProjectContextFiles(root, metadataFiles),
      tags: ["python", "package"],
      trustBoundaries: packageTrustBoundaries(metadata.name ?? basename(root)),
      skipNearbyTests: true,
    });
  }

  for (const script of metadata.scripts) {
    const resolved = await resolvePythonScript(root, script.target, script.metadataPath);
    const tests =
      resolved.entryPath === script.metadataPath
        ? []
        : associatedTests([resolved.entryPath], testFiles, testCommand);
    seeds.push({
      title: `Python CLI command ${script.name}`,
      summary:
        resolved.entryPath === script.metadataPath
          ? `Python console script '${script.name}' targets ${script.target}.`
          : `Python console script '${script.name}' targets ${script.target}, source ${resolved.entryPath}.`,
      kind: "cli-command",
      source: "python-console-script",
      confidence: resolved.entryPath === script.metadataPath ? "medium" : "high",
      entryPath: resolved.entryPath,
      symbol: resolved.symbol,
      route: null,
      command: script.name,
      ownedFiles:
        resolved.entryPath === script.metadataPath
          ? [{ path: script.metadataPath, reason: "console script metadata" }]
          : [{ path: resolved.entryPath, reason: "console script source" }],
      contextFiles: tests.map((test) => ({ path: test.path, reason: "associated test" })),
      tests,
      tags: ["python", "cli"],
      trustBoundaries: ["user-input", "filesystem", "process-exec"],
      testCommand,
      skipNearbyTests: true,
    });
  }

  for (const route of await flaskRouteSeeds(root, testFiles, testCommand)) {
    seeds.push(route);
  }

  for (const route of await fastApiRouteSeeds(root, testFiles, testCommand)) {
    seeds.push(route);
  }

  for (const group of await pythonSourceGroups(root)) {
    const tests = associatedTests(group.files, testFiles, testCommand);
    seeds.push({
      title: `Python source ${group.label}`,
      summary:
        group.files.length === 1
          ? `Python source file ${group.files[0]}.`
          : `Python source group ${group.label} with ${group.files.length} files.`,
      kind: packageKind(group.label),
      source: "python-source-group",
      confidence: "medium",
      entryPath: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: `source group ${group.label}` })),
      contextFiles: tests.map((test) => ({ path: test.path, reason: "associated test" })),
      tests,
      tags: ["python", "source-group"],
      trustBoundaries: packageTrustBoundaries(group.label),
      testCommand,
      skipNearbyTests: true,
    });
  }

  for (const test of standaloneTestSuites(testFiles, testCommand)) {
    seeds.push(test);
  }

  return seeds;
}

async function isPythonProject(root: string): Promise<boolean> {
  return (
    (await pathExists(join(root, "pyproject.toml"))) ||
    (await pathExists(join(root, "setup.py"))) ||
    (await pathExists(join(root, "setup.cfg"))) ||
    (await pathExists(join(root, "requirements.txt"))) ||
    (await containsReviewablePythonSource(root))
  );
}

async function readPythonProjectMetadata(root: string): Promise<PyprojectInfo> {
  const metadata: PyprojectInfo = { name: null, scripts: [], hasPytest: false };
  if (await pathExists(join(root, "pyproject.toml"))) {
    const source = await readFile(join(root, "pyproject.toml"), "utf8");
    metadata.name =
      tomlStringValue(table(source, "project"), "name") ??
      tomlStringValue(table(source, "tool.poetry"), "name");
    metadata.scripts.push(
      ...scriptsFromTable(table(source, "project.scripts"), "pyproject.toml"),
      ...scriptsFromTable(table(source, "tool.poetry.scripts"), "pyproject.toml"),
    );
    metadata.hasPytest =
      table(source, "tool.pytest.ini_options").length > 0 || dependencyNames(source).has("pytest");
  }
  if (await pathExists(join(root, "setup.cfg"))) {
    const source = await readFile(join(root, "setup.cfg"), "utf8");
    metadata.name ??= setupCfgStringValue(source, "metadata", "name");
    metadata.scripts.push(...setupCfgConsoleScripts(source));
    metadata.hasPytest ||= /^\s*(?:\[tool:pytest\]|\[pytest\])\s*(?:#.*)?$/mu.test(source);
  }
  if (await pathExists(join(root, "setup.py"))) {
    const source = await readFile(join(root, "setup.py"), "utf8");
    metadata.name ??= setupPyStringValue(source, "name");
    metadata.scripts.push(...setupPyConsoleScripts(source));
  }
  return metadata;
}

async function pythonMetadataFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const path of projectMetadataFiles) {
    if (await pathExists(join(root, path))) {
      files.push(path);
    }
  }
  return files;
}

async function pythonTestCommand(root: string, pyproject: PyprojectInfo): Promise<string | null> {
  if (
    !pyproject.hasPytest &&
    !(await dependencyFileHas(root, "pytest")) &&
    (await pythonTestFiles(root)).length === 0
  ) {
    return null;
  }
  if ((await pathExists(join(root, "uv.lock"))) || (await pyprojectHasToolSection(root, "uv"))) {
    return "uv run pytest";
  }
  if (
    (await pathExists(join(root, "poetry.lock"))) ||
    (await pyprojectHasToolSection(root, "poetry"))
  ) {
    return "poetry run pytest";
  }
  if ((await pathExists(join(root, "pdm.lock"))) || (await pyprojectHasToolSection(root, "pdm"))) {
    return "pdm run pytest";
  }
  if (
    (await pathExists(join(root, "hatch.toml"))) ||
    (await pyprojectHasToolSection(root, "hatch"))
  ) {
    return "hatch run pytest";
  }
  return "pytest";
}

async function pyprojectHasToolSection(root: string, tool: string): Promise<boolean> {
  if (!(await pathExists(join(root, "pyproject.toml")))) {
    return false;
  }
  const source = await readFile(join(root, "pyproject.toml"), "utf8");
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*\\[\\[?tool\\.${escaped}(?:\\.|\\])`, "mu").test(source);
}

async function dependencyFileHas(root: string, dependency: string): Promise<boolean> {
  if (await pathExists(join(root, "requirements.txt"))) {
    const source = await readFile(join(root, "requirements.txt"), "utf8");
    if (requirementNames(source).has(dependency)) {
      return true;
    }
  }
  if (await pathExists(join(root, "setup.cfg"))) {
    const source = await readFile(join(root, "setup.cfg"), "utf8");
    if (setupCfgRequirementNames(source).has(dependency)) {
      return true;
    }
  }
  return false;
}

async function pythonSourceGroups(root: string): Promise<SourceGroup[]> {
  const groups: SourceGroup[] = [];
  groups.push(...(await rootPythonSourceGroups(root)));
  const seenRoots = new Set<string>();
  for (const sourceRoot of await pythonSourceRoots(root)) {
    if (seenRoots.has(sourceRoot)) {
      continue;
    }
    seenRoots.add(sourceRoot);
    const files = (await walk(root, [sourceRoot])).filter(isReviewablePythonSourceFile);
    for (const group of partitionSourceFiles(sourceRoot, files, sourceGroupMaxOwnedFiles)) {
      groups.push(group);
    }
  }
  return groups;
}

async function rootPythonSourceGroups(root: string): Promise<SourceGroup[]> {
  return chunkFiles("root", await rootPythonSourceFiles(root), sourceGroupMaxOwnedFiles);
}

async function rootPythonSourceFiles(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && isReviewablePythonSourceFile(entry.name))
    .map((entry) => entry.name)
    .toSorted();
}

async function pythonSourceRoots(root: string): Promise<string[]> {
  const roots: string[] = [];
  for (const sourceRoot of sourceRoots) {
    if (await isSafeDirectory(root, join(root, sourceRoot))) {
      roots.push(sourceRoot);
    }
  }
  for (const entry of await readdir(root).catch(() => [])) {
    const packageRoot = join(root, entry);
    if (
      !pythonShouldSkip(entry) &&
      (await isSafeDirectory(root, packageRoot)) &&
      (await pathExists(join(packageRoot, "__init__.py")))
    ) {
      roots.push(entry);
    }
  }
  return roots.toSorted();
}

async function pythonTestFiles(root: string): Promise<string[]> {
  const rootTests = await rootPythonTestFiles(root);
  const nestedTests = (await walk(root, ["tests", "test", ...(await pythonSourceRoots(root))]))
    .filter(isPythonTestPath)
    .filter((path) => !pythonShouldSkip(path) && !isPythonFixturePath(path));
  return uniquePaths([...rootTests, ...nestedTests]).slice(0, 200);
}

async function rootPythonTestFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && isPythonTestPath(entry.name))
    .map((entry) => entry.name)
    .toSorted();
}

async function pythonProjectContextFiles(
  root: string,
  ownedMetadataFiles: readonly string[],
): Promise<SeedFileRef[]> {
  const refs: SeedFileRef[] = [];
  const owned = new Set(ownedMetadataFiles);
  for (const path of ["requirements.txt", "setup.cfg", "setup.py", "README.md"]) {
    if (!owned.has(path) && (await pathExists(join(root, path)))) {
      refs.push({ path, reason: "python project context" });
    }
  }
  return refs;
}

async function resolvePythonScript(
  root: string,
  target: string,
  metadataPath: string,
): Promise<{ entryPath: string; symbol: string | null }> {
  const [moduleName, symbol = null] = target.split(":");
  if (moduleName === undefined || moduleName.length === 0) {
    return { entryPath: metadataPath, symbol };
  }
  const modulePath = `${moduleName.replace(/\./gu, "/")}.py`;
  const packageInitPath = `${moduleName.replace(/\./gu, "/")}/__init__.py`;
  const candidates = new Set<string>([modulePath, packageInitPath]);
  for (const sourceRoot of await pythonSourceRoots(root)) {
    candidates.add(`${sourceRoot}/${modulePath}`);
    candidates.add(`${sourceRoot}/${packageInitPath}`);
  }
  for (const candidate of candidates) {
    if (await isSafeFile(root, join(root, candidate))) {
      return { entryPath: candidate, symbol };
    }
  }
  return { entryPath: metadataPath, symbol };
}

async function fastApiRouteSeeds(
  root: string,
  testFiles: string[],
  testCommand: string | null,
): Promise<FeatureSeed[]> {
  const routeFiles = uniquePaths([
    ...(await rootPythonSourceFiles(root)),
    ...(await walk(root, await pythonSourceRoots(root))).filter(isReviewablePythonSourceFile),
  ]);
  const seeds: FeatureSeed[] = [];
  for (const filePath of routeFiles) {
    const source = await readFile(join(root, filePath), "utf8");
    if (!sourceLooksFastApi(source)) {
      continue;
    }
    const routes = parseFastApiRoutes(filePath, source);
    for (const route of routes) {
      const methodLabel = route.methods.join(",");
      const tests = associatedTests([route.filePath], testFiles, testCommand);
      seeds.push({
        title: `FastAPI route ${methodLabel} ${route.routePath}`,
        summary:
          `FastAPI route ${methodLabel} ${route.routePath} handled by ` +
          `${route.functionName} in ${route.filePath}.`,
        kind: "route",
        source: "python-fastapi-route",
        confidence: "high",
        entryPath: route.filePath,
        symbol: route.functionName,
        route: `${methodLabel} ${route.routePath}`,
        command: null,
        ownedFiles: [
          { path: route.filePath, reason: `FastAPI route handler ${route.functionName}` },
        ],
        contextFiles: tests.map((test) => ({ path: test.path, reason: "associated test" })),
        tests,
        tags: ["python", "fastapi", "route"],
        trustBoundaries: fastApiRouteTrustBoundaries(route),
        testCommand,
        skipNearbyTests: true,
      });
    }
  }
  return seeds;
}

function sourceLooksFastApi(source: string): boolean {
  return /^\s*(?:from\s+fastapi\s+import\s+|import\s+fastapi\b)/mu.test(source);
}

function parseFastApiRoutes(filePath: string, source: string): FastApiRoute[] {
  const routes: FastApiRoute[] = [];
  let pending: Array<{ routePath: string; methods: string[] }> = [];
  let decoratorSource: string | null = null;
  let decoratorDepth = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (decoratorSource !== null) {
      decoratorSource = `${decoratorSource} ${trimmed}`;
      decoratorDepth += parenDelta(trimmed);
      if (decoratorDepth <= 0) {
        const route = parseFastApiRouteDecorator(decoratorSource);
        if (route !== null) {
          pending.push(route);
        }
        decoratorSource = null;
        decoratorDepth = 0;
      }
      continue;
    }

    if (startsFastApiRouteDecorator(trimmed)) {
      decoratorSource = trimmed;
      decoratorDepth = parenDelta(trimmed);
      if (decoratorDepth <= 0) {
        const route = parseFastApiRouteDecorator(decoratorSource);
        if (route !== null) {
          pending.push(route);
        }
        decoratorSource = null;
        decoratorDepth = 0;
      }
      continue;
    }

    const functionName = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(line)?.[1];
    if (functionName !== undefined && pending.length > 0) {
      for (const item of pending) {
        routes.push({ filePath, functionName, ...item });
      }
      pending = [];
      continue;
    }

    if (
      pending.length > 0 &&
      trimmed !== "" &&
      !trimmed.startsWith("@") &&
      !trimmed.startsWith("#")
    ) {
      pending = [];
    }
  }
  return routes;
}

function startsFastApiRouteDecorator(line: string): boolean {
  return fastApiRouteDecoratorStartPattern.test(line);
}

function parseFastApiRouteDecorator(line: string): { routePath: string; methods: string[] } | null {
  const match = fastApiRouteDecoratorPattern.exec(line);
  const method = match?.[1];
  const args = match?.[2];
  if (method === undefined || args === undefined) {
    return null;
  }
  const routePath = parseFastApiPath(args);
  if (routePath === null) {
    return null;
  }
  const methods = method === "api_route" ? parsePythonRouteMethods(args) : [method.toUpperCase()];
  if (methods === null) {
    return null;
  }
  return { routePath, methods };
}

function parseFastApiPath(args: string): string | null {
  const positional = /^\s*(["'])(.*?)\1/u.exec(args)?.[2];
  if (positional !== undefined) {
    return positional;
  }
  return /\bpath\s*=\s*(["'])(.*?)\1/u.exec(args)?.[2] ?? null;
}

async function flaskRouteSeeds(
  root: string,
  testFiles: string[],
  testCommand: string | null,
): Promise<FeatureSeed[]> {
  const hasFlaskDependency = await pythonDependencyHas(root, "flask");
  const routeFiles = await flaskRouteFiles(root);
  const seeds: FeatureSeed[] = [];
  for (const filePath of routeFiles) {
    const source = await readFile(join(root, filePath), "utf8");
    if (!hasFlaskDependency && !sourceLooksFlask(source)) {
      continue;
    }
    const routes = parseFlaskRoutes(filePath, source);
    for (const route of routes) {
      const methodLabel = route.methods.join(",");
      const tests = associatedTests([route.filePath], testFiles, testCommand);
      seeds.push({
        title: `Flask route ${methodLabel} ${route.routePath}`,
        summary: `Flask route ${methodLabel} ${route.routePath} handled by ${route.functionName} in ${route.filePath}.`,
        kind: "route",
        source: "python-flask-route",
        confidence: "high",
        entryPath: route.filePath,
        symbol: route.functionName,
        route: `${methodLabel} ${route.routePath}`,
        command: null,
        ownedFiles: [{ path: route.filePath, reason: `Flask route handler ${route.functionName}` }],
        contextFiles: tests.map((test) => ({ path: test.path, reason: "associated test" })),
        tests,
        tags: ["python", "flask", "route"],
        trustBoundaries: flaskRouteTrustBoundaries(route),
        testCommand,
        skipNearbyTests: true,
      });
    }
  }
  return seeds;
}

async function flaskRouteFiles(root: string): Promise<string[]> {
  const rootEntries: string[] = [];
  for (const filePath of flaskRootEntryFiles) {
    if (isReviewablePythonSourceFile(filePath) && (await isSafeFile(root, join(root, filePath)))) {
      rootEntries.push(filePath);
    }
  }
  const rootedFiles = (await walk(root, await pythonSourceRoots(root))).filter(
    isReviewablePythonSourceFile,
  );
  return uniquePaths([...rootEntries, ...rootedFiles]);
}

async function pythonDependencyHas(root: string, dependency: string): Promise<boolean> {
  if (await pathExists(join(root, "pyproject.toml"))) {
    const source = await readFile(join(root, "pyproject.toml"), "utf8");
    if (dependencyNames(source).has(dependency)) {
      return true;
    }
  }
  return dependencyFileHas(root, dependency);
}

function sourceLooksFlask(source: string): boolean {
  return /^\s*(?:from\s+flask\s+import\s+|import\s+flask\b)/mu.test(source);
}

function parseFlaskRoutes(filePath: string, source: string): FlaskRoute[] {
  const routes: FlaskRoute[] = [];
  let pending: Array<{ routePath: string; methods: string[] }> = [];
  let decoratorSource: string | null = null;
  let decoratorDepth = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (decoratorSource !== null) {
      decoratorSource = `${decoratorSource} ${trimmed}`;
      decoratorDepth += parenDelta(trimmed);
      if (decoratorDepth <= 0) {
        const route = parseFlaskRouteDecorator(decoratorSource);
        if (route !== null) {
          pending.push(route);
        }
        decoratorSource = null;
        decoratorDepth = 0;
      }
      continue;
    }

    if (startsFlaskRouteDecorator(trimmed)) {
      decoratorSource = trimmed;
      decoratorDepth = parenDelta(trimmed);
      if (decoratorDepth <= 0) {
        const route = parseFlaskRouteDecorator(decoratorSource);
        if (route !== null) {
          pending.push(route);
        }
        decoratorSource = null;
        decoratorDepth = 0;
      }
      continue;
    }

    const functionName = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(line)?.[1];
    if (functionName !== undefined && pending.length > 0) {
      for (const item of pending) {
        routes.push({ filePath, functionName, ...item });
      }
      pending = [];
      continue;
    }

    if (
      pending.length > 0 &&
      trimmed !== "" &&
      !trimmed.startsWith("@") &&
      !trimmed.startsWith("#")
    ) {
      pending = [];
    }
  }
  return routes;
}

function startsFlaskRouteDecorator(line: string): boolean {
  return /^@[A-Za-z_][A-Za-z0-9_.]*\.route\(/u.test(line);
}

function parseFlaskRouteDecorator(line: string): { routePath: string; methods: string[] } | null {
  const match = /^\s*@[A-Za-z_][A-Za-z0-9_.]*\.route\(\s*(["'])(.*?)\1(.*)\)\s*(?:#.*)?$/u.exec(
    line,
  );
  if (match?.[2] === undefined) {
    return null;
  }
  const methods = parsePythonRouteMethods(match[3] ?? "");
  if (methods === null) {
    return null;
  }
  return {
    routePath: match[2],
    methods,
  };
}

function parsePythonRouteMethods(args: string): string[] | null {
  const methodsIndex = args.search(/\bmethods\s*=/u);
  if (methodsIndex === -1) {
    return ["GET"];
  }
  const literal = pythonRouteMethodsLiteral(args.slice(methodsIndex));
  if (literal === null) {
    return null;
  }
  const methods = [...literal.matchAll(/["']([^"']+)["']/gu)]
    .map((item) => item[1]?.toUpperCase())
    .filter((item): item is string => item !== undefined && item.length > 0);
  return methods.length > 0 ? [...new Set(methods)] : null;
}

function pythonRouteMethodsLiteral(source: string): string | null {
  const match = /^\s*methods\s*=\s*([[({])/u.exec(source);
  if (match === null) {
    return null;
  }
  const opener = match[1];
  if (opener === undefined) {
    return null;
  }
  const literalStart = match[0].length;
  const closer = opener === "[" ? "]" : opener === "(" ? ")" : "}";
  let quote: string | null = null;
  let escaped = false;
  let depth = 0;
  for (let index = literalStart - 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) {
      break;
    }
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
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === opener) {
      depth += 1;
      continue;
    }
    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(literalStart, index);
      }
    }
  }
  return null;
}

function parenDelta(line: string): number {
  let delta = 0;
  let quote: string | null = null;
  let escaped = false;
  for (const char of line) {
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
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      delta += 1;
    } else if (char === ")") {
      delta -= 1;
    }
  }
  return delta;
}

function flaskRouteTrustBoundaries(route: FlaskRoute): FeatureSeed["trustBoundaries"] {
  const boundaries: FeatureSeed["trustBoundaries"] = ["network", "user-input", "serialization"];
  if (
    route.methods.some((method) => method !== "GET") ||
    /(^|\/)(admin|auth|login|token)(\/|$)/iu.test(route.routePath)
  ) {
    boundaries.push("auth");
  }
  return boundaries;
}

function fastApiRouteTrustBoundaries(route: FastApiRoute): FeatureSeed["trustBoundaries"] {
  const boundaries: FeatureSeed["trustBoundaries"] = ["network", "user-input", "serialization"];
  if (
    route.methods.some((method) => method !== "GET") ||
    /(^|\/)(admin|auth|login|token)(\/|$)/iu.test(route.routePath)
  ) {
    boundaries.push("auth");
  }
  return boundaries;
}

function standaloneTestSuites(testFiles: string[], command: string | null): FeatureSeed[] {
  if (testFiles.length === 0) {
    return [];
  }
  const groups: SourceGroup[] = [];
  for (const [root, files] of groupedTestFiles(testFiles)) {
    groups.push(...partitionSourceFiles(root, files, sourceGroupMaxOwnedFiles));
  }
  return groups.map((group) => ({
    title: `Python test suite ${group.label}`,
    summary: `Python pytest files in ${group.label}.`,
    kind: "test-suite",
    source: "python-test-suite",
    confidence: "medium",
    entryPath: group.label,
    symbol: group.label,
    route: null,
    command: null,
    ownedFiles: group.files.map((path) => ({ path, reason: "pytest file" })),
    contextFiles: [],
    tests: group.files.map((path) => ({ path, command })),
    tags: ["python", "test"],
    trustBoundaries: [],
    testCommand: command,
    skipNearbyTests: true,
  }));
}

function groupedTestFiles(testFiles: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of testFiles) {
    const root = testSuiteRoot(path);
    const files = groups.get(root) ?? [];
    files.push(path);
    groups.set(root, files);
  }
  return new Map([...groups.entries()].toSorted(([left], [right]) => left.localeCompare(right)));
}

function testSuiteRoot(path: string): string {
  if (!path.includes("/") && (/^test_[^/]+\.py$/u.test(path) || path.endsWith("_test.py"))) {
    return "tests";
  }
  const first = path.split("/")[0];
  if (first === "test" || first === "tests") {
    return first;
  }
  return dirname(path);
}

function partitionSourceFiles(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
): SourceGroup[] {
  return partitionAt(sourceRoot, files.toSorted(), maxFiles, 0);
}

function partitionAt(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
  depth: number,
): SourceGroup[] {
  if (files.length === 0) {
    return [];
  }
  if (files.length <= maxFiles) {
    return [{ label: commonLabel(sourceRoot, files, depth), files }];
  }
  const directFiles: string[] = [];
  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const relativePath = file.slice(sourceRoot.length + 1);
    const parts = relativePath.split("/");
    if (parts.length <= depth + 1) {
      directFiles.push(file);
      continue;
    }
    const segment = parts[depth];
    if (segment === undefined) {
      directFiles.push(file);
      continue;
    }
    const bucket = buckets.get(segment) ?? [];
    bucket.push(file);
    buckets.set(segment, bucket);
  }
  const groups = chunkFiles(currentLabel(sourceRoot, files, depth), directFiles, maxFiles);
  for (const [segment, bucketFiles] of [...buckets.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (bucketFiles.length <= maxFiles) {
      groups.push({
        label: `${sourceRoot}/${bucketPrefix(bucketFiles, sourceRoot, depth, segment)}`,
        files: bucketFiles,
      });
    } else {
      groups.push(...partitionAt(sourceRoot, bucketFiles, maxFiles, depth + 1));
    }
  }
  return groups;
}

function chunkFiles(label: string, files: string[], maxFiles: number): SourceGroup[] {
  const groups: SourceGroup[] = [];
  for (let index = 0; index < files.length; index += maxFiles) {
    const part = Math.floor(index / maxFiles) + 1;
    groups.push({
      label: files.length <= maxFiles ? label : `${label}#${part}`,
      files: files.slice(index, index + maxFiles),
    });
  }
  return groups;
}

function currentLabel(sourceRoot: string, files: string[], depth: number): string {
  if (depth === 0) {
    return sourceRoot;
  }
  const first = files[0];
  if (first === undefined) {
    return sourceRoot;
  }
  const parts = first
    .slice(sourceRoot.length + 1)
    .split("/")
    .slice(0, depth);
  return parts.length === 0 ? sourceRoot : `${sourceRoot}/${parts.join("/")}`;
}

function commonLabel(sourceRoot: string, files: string[], depth: number): string {
  if (depth === 0) {
    if (sourceRoot === "tests") {
      return sourceRoot;
    }
    const first = files[0];
    return files.length === 1 && first !== undefined && !first.startsWith(`${sourceRoot}/`)
      ? first
      : sourceRoot;
  }
  if (files.length === 1) {
    return files[0] ?? sourceRoot;
  }
  return currentLabel(sourceRoot, files, depth);
}

function bucketPrefix(files: string[], sourceRoot: string, depth: number, segment: string): string {
  const first = files[0];
  if (first === undefined || depth === 0) {
    return segment;
  }
  const parts = first
    .slice(sourceRoot.length + 1)
    .split("/")
    .slice(0, depth);
  return [...parts, segment].join("/");
}

function associatedTests(files: string[], tests: string[], command: string | null): SeedTestRef[] {
  const fileStems = new Set(files.map((file) => basename(file).replace(/\.py$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  return tests
    .filter((test) => {
      const testStem = basename(test)
        .replace(/^test_/u, "")
        .replace(/_test\.py$/u, "")
        .replace(/\.py$/u, "");
      return (
        [...dirs].some((dir) => pathMatchesPrefix(test, dir)) ||
        (fileStems.has(testStem) && (/^(tests?|__tests__)\//u.test(test) || !test.includes("/")))
      );
    })
    .slice(0, sourceGroupMaxTests)
    .map((path) => ({ path, command }));
}

function isReviewablePythonSourceFile(path: string): boolean {
  return (
    path.endsWith(".py") &&
    !isPythonTestPath(path) &&
    !pythonShouldSkip(path) &&
    !isPythonFixturePath(path) &&
    !/(^|\/)[^/]*(?:generated|_pb2|_pb2_grpc|\.gen)\.py$/iu.test(path)
  );
}

function isPythonFixturePath(path: string): boolean {
  return /(^|\/)(__fixtures__|fixtures|testdata)(\/|$)/u.test(path);
}

function isPythonTestPath(path: string): boolean {
  const name = basename(path);
  return path.endsWith(".py") && (/^test_[^/]+\.py$/u.test(name) || name.endsWith("_test.py"));
}

function pythonShouldSkip(path: string): boolean {
  return (
    shouldSkip(path) ||
    /(^|\/)(\.venv(?:-[^/]+)?|venv|__pycache__|\.mypy_cache|\.ruff_cache|\.pytest_cache)(\/|$)/u.test(
      path,
    )
  );
}

async function containsReviewablePythonSource(root: string): Promise<boolean> {
  if ((await rootPythonSourceFiles(root)).length > 0) {
    return true;
  }
  for (const sourceRoot of sourceRoots) {
    if (await containsPythonSourceInDirectory(root, sourceRoot, 4)) {
      return true;
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (
      entry.isDirectory() &&
      !pythonShouldSkip(entry.name) &&
      (await pathExists(join(root, entry.name, "__init__.py")))
    ) {
      return true;
    }
  }
  return false;
}

async function containsPythonSourceInDirectory(
  root: string,
  prefix: string,
  remainingDepth: number,
): Promise<boolean> {
  if (remainingDepth < 0 || pythonShouldSkip(prefix)) {
    return false;
  }
  const dir = join(root, prefix);
  if (!(await isSafeDirectory(root, dir))) {
    return false;
  }
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = `${prefix}/${entry.name}`;
    if (pythonShouldSkip(rel)) {
      continue;
    }
    if (entry.isFile() && isReviewablePythonSourceFile(rel)) {
      return true;
    }
    if (
      entry.isDirectory() &&
      (await containsPythonSourceInDirectory(root, rel, remainingDepth - 1))
    ) {
      return true;
    }
  }
  return false;
}

function table(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*\\[${escapedName}\\]\\s*(?:#.*)?$`, "mu").exec(source);
  if (match?.index === undefined) {
    return "";
  }
  const rest = source.slice(match.index + match[0].length);
  const nextSection = tomlHeaderPattern.exec(rest);
  return nextSection?.index === undefined ? rest : rest.slice(0, nextSection.index);
}

function tablesMatching(source: string, pattern: RegExp): string[] {
  const tables: string[] = [];
  for (const match of source.matchAll(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/gmu)) {
    const name = match[1];
    if (name === undefined || !pattern.test(name)) {
      continue;
    }
    const start = match.index + match[0].length;
    const rest = source.slice(start);
    const next = tomlHeaderPattern.exec(rest);
    tables.push(next?.index === undefined ? rest : rest.slice(0, next.index));
  }
  return tables;
}

const tomlHeaderPattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/mu;

function tomlStringValue(source: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escapedKey}\\s*=\\s*(["'])([^"']+)\\1`, "mu").exec(source)?.[2] ?? null;
}

function scriptsFromTable(source: string, metadataPath: string): PythonScript[] {
  const scripts: PythonScript[] = [];
  for (const line of source.split("\n")) {
    const match = /^\s*["']?([^#"'=\s]+)["']?\s*=\s*(["'])([^"']+)\2/u.exec(line);
    if (match?.[1] !== undefined && match[3] !== undefined) {
      scripts.push({ name: match[1], target: match[3], metadataPath });
    }
  }
  return scripts;
}

function setupCfgStringValue(source: string, sectionName: string, keyName: string): string | null {
  const section = iniSection(source, sectionName);
  const escapedKey = keyName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*([^#;\\r\\n]+)`, "imu").exec(section)?.[1]?.trim() ??
    null
  );
}

function setupCfgConsoleScripts(source: string): PythonScript[] {
  const scripts: PythonScript[] = [];
  const section = iniSection(source, "options.entry_points");
  let inConsoleScripts = false;
  for (const rawLine of section.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (/^\s*(?:#|;|$)/u.test(line)) {
      continue;
    }
    const assignment = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line);
    if (assignment !== null) {
      if (!/^\s/u.test(line)) {
        inConsoleScripts = assignment[1] === "console_scripts";
        const inlineScript = inConsoleScripts ? consoleScriptFromEntry(assignment[2] ?? "") : null;
        if (inlineScript !== null) {
          scripts.push({ ...inlineScript, metadataPath: "setup.cfg" });
        }
        continue;
      }
      if (inConsoleScripts) {
        scripts.push({
          name: assignment[1] ?? "",
          target: (assignment[2] ?? "").trim(),
          metadataPath: "setup.cfg",
        });
      }
      continue;
    }
    const script = inConsoleScripts ? consoleScriptFromEntry(line) : null;
    if (script !== null) {
      scripts.push({ ...script, metadataPath: "setup.cfg" });
    }
  }
  return scripts.filter((script) => script.name.length > 0 && script.target.length > 0);
}

function setupPyStringValue(source: string, keyName: string): string | null {
  const escapedKey = keyName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escapedKey}\\s*=\\s*(["'])([^"']+)\\1`, "su").exec(source)?.[2] ?? null;
}

function setupPyConsoleScripts(source: string): PythonScript[] {
  const scripts: PythonScript[] = [];
  for (const block of source.matchAll(/console_scripts["']?\s*[:=]\s*\[([\s\S]*?)\]/gu)) {
    const entries = block[1] ?? "";
    for (const match of entries.matchAll(/["']([^"']+)["']/gu)) {
      const script = consoleScriptFromEntry(match[1] ?? "");
      if (script !== null) {
        scripts.push({ ...script, metadataPath: "setup.py" });
      }
    }
  }
  return scripts;
}

function consoleScriptFromEntry(source: string): Omit<PythonScript, "metadataPath"> | null {
  const match =
    /^\s*([A-Za-z0-9_.-]+)\s*=\s*([A-Za-z_][A-Za-z0-9_.]*(?::[A-Za-z_][A-Za-z0-9_]*)?)\s*$/u.exec(
      source,
    );
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { name: match[1], target: match[2] };
}

function iniSection(source: string, sectionName: string): string {
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*\\[${escapedName}\\]\\s*(?:[#;].*)?$`, "imu").exec(source);
  if (match?.index === undefined) {
    return "";
  }
  const rest = source.slice(match.index + match[0].length);
  const next = /^\s*\[[^\]]+\]\s*(?:[#;].*)?$/mu.exec(rest);
  return next?.index === undefined ? rest : rest.slice(0, next.index);
}

function dependencyNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const array of tomlArrayAssignments(source, ["dependencies", "dev-dependencies"])) {
    for (const value of arrayValues(array)) {
      const name = requirementName(value);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  for (const dependencyTable of [
    table(source, "tool.uv"),
    table(source, "tool.pdm.dev-dependencies"),
    table(source, "tool.poetry.dependencies"),
    table(source, "tool.poetry.dev-dependencies"),
    ...tablesMatching(source, /^tool\.hatch\.envs\.[^.]+$/u),
    ...tablesMatching(source, /^tool\.poetry\.group\.[^.]+\.dependencies$/u),
  ]) {
    for (const value of assignedKeysAndValues(dependencyTable)) {
      const name = requirementName(value);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  for (const dependencyTable of [
    table(source, "project.optional-dependencies"),
    table(source, "dependency-groups"),
    table(source, "tool.pdm.dev-dependencies"),
  ]) {
    for (const value of assignedValues(dependencyTable)) {
      const name = requirementName(value);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  return names;
}

function tomlArrayAssignments(source: string, keys: string[]): string[] {
  const arrays: string[] = [];
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const match of source.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*\\[`, "gmu"))) {
      arrays.push(readBracketValue(source, match.index + match[0].lastIndexOf("[")));
    }
  }
  return arrays;
}

function assignedValues(source: string): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(/^\s*["']?[^#"'=\s]+["']?\s*=\s*/gmu)) {
    if (match.index === undefined) {
      continue;
    }
    const valueStart = match.index + match[0].length;
    const lineEnd = source.indexOf("\n", valueStart);
    const rawValue = source.slice(valueStart, lineEnd === -1 ? source.length : lineEnd).trim();
    if (rawValue.startsWith("[")) {
      values.push(...arrayValues(readBracketValue(source, valueStart)));
      continue;
    }
    values.push(...arrayValues(rawValue));
  }
  return values;
}

function assignedKeysAndValues(source: string): string[] {
  const values = assignedValues(source);
  for (const line of source.split("\n")) {
    const key = /^\s*["']?([^#"'=\s]+)["']?\s*=/u.exec(line)?.[1];
    if (key !== undefined) {
      values.push(key);
    }
  }
  return values;
}

function arrayValues(source: string): string[] {
  return stringValues(source);
}

function stringValues(source: string): string[] {
  const values: string[] = [];
  let quote: string | null = null;
  let value = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === "\\" && quote === '"') {
        escaped = true;
      } else if (char === quote) {
        values.push(value);
        quote = null;
        value = "";
      } else {
        value += char;
      }
      continue;
    }
    if (char === "#") {
      const nextNewline = source.indexOf("\n", index + 1);
      if (nextNewline === -1) {
        break;
      }
      index = nextNewline;
    } else if (char === '"' || char === "'") {
      quote = char;
      value = "";
    }
  }
  return values;
}

function readBracketValue(source: string, bracketIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = bracketIndex; index < source.length; index += 1) {
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
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bracketIndex, index + 1);
      }
    }
  }
  return source.slice(bracketIndex);
}

function requirementNames(source: string): Set<string> {
  return new Set(
    source
      .split("\n")
      .map((line) => requirementName(line))
      .filter((name): name is string => name !== null),
  );
}

function setupCfgRequirementNames(source: string): Set<string> {
  const names = new Set<string>();
  let section = "";
  let collecting = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (/^\s*(?:#|;|$)/u.test(line)) {
      continue;
    }
    const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1].toLowerCase();
      collecting = false;
      continue;
    }
    if (section !== "options" && section !== "options.extras_require") {
      continue;
    }
    const assignment = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line);
    if (assignment !== null) {
      const key = assignment[1]?.toLowerCase().replace(/-/gu, "_") ?? "";
      collecting =
        section === "options"
          ? ["install_requires", "setup_requires", "tests_require"].includes(key)
          : true;
      if (collecting && assignment[2] !== undefined) {
        addRequirementNames(names, assignment[2]);
      }
      continue;
    }
    if (collecting && /^\s+/u.test(line)) {
      addRequirementNames(names, line);
    }
  }
  return names;
}

function addRequirementNames(names: Set<string>, value: string): void {
  for (const part of value.split(",")) {
    const name = requirementName(part);
    if (name !== null) {
      names.add(name);
    }
  }
}

function requirementName(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/gu, "");
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("-")) {
    return null;
  }
  const match = /^([A-Za-z0-9_.-]+)/u.exec(trimmed);
  return match?.[1]?.toLowerCase().replace(/_/gu, "-") ?? null;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}
