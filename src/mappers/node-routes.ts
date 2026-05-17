import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  dependencyFieldHas,
  packageRelativePath,
  projectContextFiles,
  projectTags,
  projectTargetCommand,
} from "./projects.js";
import { pathMatchesPrefix, walk } from "./shared.js";
import {
  FeatureSeed,
  MapperContext,
  SeedFileRef,
  SeedTestRef,
  suppressedTestCommandTag,
} from "./types.js";
import type { NodeProjectInfo } from "./projects.js";

type ServerFramework = "express" | "fastify" | "hono";

type ServerRoute = {
  framework: ServerFramework;
  filePath: string;
  method: string;
  routePath: string;
  symbol: string | null;
};

const sourceRoots = ["src", "lib", "app", "server", "routes", "api"] as const;
const sourceExtensions = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"] as const;
const rootEntryFiles = ["server", "app", "index", "main", "api"].flatMap((name) =>
  sourceExtensions.map((extension) => `${name}.${extension}`),
);
const testRoots = ["src", "lib", "app", "server", "routes", "api", "test", "tests", "__tests__"];
const routeMethods = ["get", "post", "put", "patch", "delete", "options", "head", "all"] as const;
const routeMethodPattern = new RegExp(
  `(^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*)\\s*\\.\\s*(${routeMethods.join("|")})\\s*\\(`,
  "gu",
);
const routeChainPattern =
  /(^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\.\s*route\s*\(/gu;

export async function nodeRouteSeeds(root: string, context: MapperContext): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  const rootFrameworks = serverFrameworks(
    context.projects.find((project) => project.root === ".") ?? null,
  );
  for (const project of context.projects) {
    const frameworks = serverFrameworks(project);
    const effectiveFrameworks =
      frameworks.length > 0 || project.packageJson !== null ? frameworks : rootFrameworks;
    if (frameworks.length === 0) {
      if (effectiveFrameworks.length === 0) {
        continue;
      }
    }
    seeds.push(...(await projectRouteSeeds(root, project, context, effectiveFrameworks)));
  }
  return seeds;
}

function serverFrameworks(project: NodeProjectInfo | null): ServerFramework[] {
  if (project === null) {
    return [];
  }
  return (["express", "fastify", "hono"] as const).filter((framework) =>
    packageHasDependency(project, framework),
  );
}

function packageHasDependency(project: NodeProjectInfo, dependency: string): boolean {
  const pkg = project.packageJson as Record<string, unknown> | null;
  if (pkg === null) {
    return false;
  }
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some(
    (field) => dependencyFieldHas(pkg[field], dependency),
  );
}

async function projectRouteSeeds(
  root: string,
  project: NodeProjectInfo,
  context: MapperContext,
  frameworks: ServerFramework[],
): Promise<FeatureSeed[]> {
  const files = await packageSourceFiles(root, project);
  const tests = await packageTestFiles(root, project);
  const testCommand = projectTargetCommand(project, "test", context.taskGraph);
  const projectContext = await projectContextFiles(root, project);
  const seeds: FeatureSeed[] = [];

  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    for (const route of parseServerRoutes(source, file, frameworks)) {
      const routeTests = associatedTests([route.filePath], tests, testCommand ?? null);
      const frameworkLabel = frameworkTitle(route.framework);
      seeds.push({
        title: `${frameworkLabel} route ${route.method} ${route.routePath}`,
        summary: `${frameworkLabel} route ${route.method} ${route.routePath} declared in ${route.filePath}.`,
        kind: "route",
        source: `${route.framework}-route`,
        confidence: "medium",
        entryPath: route.filePath,
        symbol: route.symbol,
        route: `${route.method} ${route.routePath}`,
        command: null,
        ownedFiles: [{ path: route.filePath, reason: `${frameworkLabel} route declaration` }],
        contextFiles: uniqueFileRefs([
          ...projectContext,
          ...routeTests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests: routeTests,
        tags: [
          "node",
          route.framework,
          "route",
          "api",
          ...projectTags(project),
          ...(testCommand === null ? [suppressedTestCommandTag] : []),
        ],
        trustBoundaries: routeTrustBoundaries(route),
        ...(testCommand === undefined ? {} : { testCommand }),
        skipNearbyTests: true,
      });
    }
  }

  return seeds;
}

function parseServerRoutes(
  source: string,
  filePath: string,
  projectFrameworks: ServerFramework[],
): ServerRoute[] {
  const routes: ServerRoute[] = [];
  for (const framework of projectFrameworks) {
    const targets = routeTargetNames(source, framework);
    if (targets.size === 0) {
      continue;
    }
    routes.push(...directMethodRoutes(source, filePath, framework, targets));
    if (framework === "express") {
      routes.push(...expressRouteChains(source, filePath, targets));
    }
  }
  return uniqueRoutes(routes);
}

function directMethodRoutes(
  source: string,
  filePath: string,
  framework: ServerFramework,
  targets: ReadonlySet<string>,
): ServerRoute[] {
  const routes: ServerRoute[] = [];
  routeMethodPattern.lastIndex = 0;
  for (const match of source.matchAll(routeMethodPattern)) {
    const matchIndex = match.index ?? 0;
    const targetIndex = matchIndex + (match[1]?.length ?? 0);
    if (isInsideCommentOrString(source, targetIndex)) {
      continue;
    }
    const target = match[2];
    const method = match[3];
    if (target === undefined || method === undefined || !isRouteTarget(targets, target)) {
      continue;
    }
    const openParenIndex = matchIndex + match[0].lastIndexOf("(");
    const routePath = readStringLiteralArgument(source, openParenIndex + 1);
    if (routePath === null || !isRoutePath(routePath.value)) {
      continue;
    }
    routes.push({
      framework,
      filePath,
      method: method.toUpperCase(),
      routePath: routePath.value,
      symbol: readHandlerSymbol(source, routePath.end),
    });
  }
  return routes;
}

function expressRouteChains(
  source: string,
  filePath: string,
  targets: ReadonlySet<string>,
): ServerRoute[] {
  const routes: ServerRoute[] = [];
  routeChainPattern.lastIndex = 0;
  for (const match of source.matchAll(routeChainPattern)) {
    const matchIndex = match.index ?? 0;
    const targetIndex = matchIndex + (match[1]?.length ?? 0);
    if (isInsideCommentOrString(source, targetIndex)) {
      continue;
    }
    const target = match[2];
    if (target === undefined || !isRouteTarget(targets, target)) {
      continue;
    }
    const openParenIndex = matchIndex + match[0].lastIndexOf("(");
    const routePath = readStringLiteralArgument(source, openParenIndex + 1);
    if (routePath === null || !isRoutePath(routePath.value)) {
      continue;
    }
    for (const method of expressChainMethods(source, routePath.end)) {
      routes.push({
        framework: "express",
        filePath,
        method,
        routePath: routePath.value,
        symbol: null,
      });
    }
  }
  return routes;
}

function routeTargetNames(source: string, framework: ServerFramework): Set<string> {
  if (framework === "express") {
    return declaredTargetNames(source, [
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:express\s*\(|express\s*\.\s*Router\s*\(|Router\s*\()/gu,
    ]);
  }
  if (framework === "fastify") {
    return declaredTargetNames(source, [
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:Fastify|fastify)\s*\(/gu,
    ]);
  }
  return declaredTargetNames(source, [
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:new\s+)?Hono\s*\(/gu,
  ]);
}

function declaredTargetNames(source: string, patterns: RegExp[]): Set<string> {
  const names = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const matchIndex = match.index ?? 0;
      if (isInsideCommentOrString(source, matchIndex)) {
        continue;
      }
      const name = match[1];
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return names;
}

function isRouteTarget(targets: ReadonlySet<string>, target: string): boolean {
  return !target.includes(".") && targets.has(target);
}

function expressChainMethods(source: string, start: number): string[] {
  const methods: string[] = [];
  let cursor = endOfCall(source, start);
  while (cursor !== null) {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] !== ".") {
      return methods;
    }
    const rest = source.slice(cursor + 1);
    const methodMatch = /^(get|post|put|patch|delete|options|head|all)\s*\(/u.exec(rest);
    if (methodMatch === null) {
      return methods;
    }
    const method = methodMatch[1];
    if (method === undefined) {
      return methods;
    }
    methods.push(method.toUpperCase());
    cursor = endOfCall(source, cursor + 1 + methodMatch[0].length);
  }
  return methods;
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (/\s/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function endOfCall(source: string, start: number): number | null {
  let depth = 1;
  let quote: string | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) {
      return null;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (quote === "`" && char === "$" && source[index + 1] === "{") {
        return null;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return null;
}

function readStringLiteralArgument(
  source: string,
  start: number,
): { value: string; end: number } | null {
  let cursor = start;
  while (/\s/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  const quote = source[cursor];
  if (quote !== "'" && quote !== '"' && quote !== "`") {
    return null;
  }
  let value = "";
  let escaped = false;
  for (let index = cursor + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) {
      return null;
    }
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      return null;
    }
    if (char === quote) {
      return { value, end: index + 1 };
    }
    value += char;
  }
  return null;
}

function isRoutePath(path: string): boolean {
  return path === "*" || path.startsWith("/");
}

function readHandlerSymbol(source: string, start: number): string | null {
  let cursor = start;
  while (/\s/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  if (source[cursor] !== ",") {
    return null;
  }
  cursor += 1;
  while (/\s/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?/u.exec(
    source.slice(cursor),
  );
  const symbol = match?.[0] ?? null;
  if (
    symbol === null ||
    ["async", "function", "req", "request", "res", "response"].includes(symbol)
  ) {
    return null;
  }
  return symbol;
}

function isInsideCommentOrString(source: string, index: number): boolean {
  let state:
    | "code"
    | "line-comment"
    | "block-comment"
    | "single"
    | "double"
    | "template"
    | "regex" = "code";
  let escaped = false;
  let regexCharClass = false;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === undefined) {
      break;
    }
    if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
      }
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        cursor += 1;
        state = "code";
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        state = "code";
      }
      continue;
    }
    if (state === "regex") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "[") {
        regexCharClass = true;
      } else if (char === "]") {
        regexCharClass = false;
      } else if (char === "/" && !regexCharClass) {
        state = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      cursor += 1;
      state = "line-comment";
    } else if (char === "/" && next === "*") {
      cursor += 1;
      state = "block-comment";
    } else if (startsRegexLiteral(source, cursor)) {
      state = "regex";
      regexCharClass = false;
    } else if (char === "'") {
      state = "single";
    } else if (char === '"') {
      state = "double";
    } else if (char === "`") {
      state = "template";
    }
  }
  return state !== "code";
}

function startsRegexLiteral(source: string, index: number): boolean {
  const char = source[index];
  const next = source[index + 1];
  if (char !== "/" || next === "/" || next === "*" || next === undefined) {
    return false;
  }
  const previous = previousSignificantChar(source, index);
  return previous === null || /[([{=,:;!&|?*~^]/u.test(previous);
}

function previousSignificantChar(source: string, index: number): string | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = source[cursor];
    if (char === undefined) {
      return null;
    }
    if (!/\s/u.test(char)) {
      return char;
    }
  }
  return null;
}

async function packageSourceFiles(root: string, project: NodeProjectInfo): Promise<string[]> {
  const prefixes = [
    ...sourceRoots.map((prefix) => packageRelativePath(project.root, prefix)),
    ...(project.sourceRoot === null ? [] : [project.sourceRoot]),
    ...rootEntryFiles.map((file) => packageRelativePath(project.root, file)),
  ];
  return (await walk(root, prefixes))
    .filter((file) => pathMatchesPrefix(file, project.root === "." ? "" : project.root))
    .filter(isReviewableServerSourceFile);
}

async function packageTestFiles(root: string, project: NodeProjectInfo): Promise<string[]> {
  const prefixes = [
    ...testRoots.map((prefix) => packageRelativePath(project.root, prefix)),
    ...(project.sourceRoot === null ? [] : [project.sourceRoot]),
  ];
  return (await walk(root, prefixes)).filter(isNodeTestPath).slice(0, 200);
}

function associatedTests(files: string[], tests: string[], command: string | null): SeedTestRef[] {
  const fileStems = new Set(files.map((file) => basename(file).replace(/\.[^.]+$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  const exact = tests.filter((test) => {
    const testStem = basename(test).replace(/\.(test|spec)\.[^.]+$/u, "");
    return fileStems.has(testStem);
  });
  const candidates =
    exact.length > 0
      ? exact
      : tests.filter((test) => [...dirs].some((dir) => pathMatchesPrefix(test, dir)));
  return candidates.slice(0, 8).map((path) => ({ path, command }));
}

function isReviewableServerSourceFile(path: string): boolean {
  return (
    /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(path) &&
    !isNodeTestPath(path) &&
    !/\.d\.[cm]?ts$/u.test(path) &&
    !/(^|\/)(__fixtures__|fixtures|testdata)(\/|$)/u.test(path) &&
    !/(^|\/)[^/]*(?:generated|\.gen)\.[^.]+$/iu.test(path)
  );
}

function isNodeTestPath(path: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(path);
}

function routeTrustBoundaries(route: ServerRoute): FeatureSeed["trustBoundaries"] {
  const boundaries: FeatureSeed["trustBoundaries"] = ["user-input", "network", "serialization"];
  if (
    route.method !== "GET" ||
    /(^|\/)(admin|auth|login|logout|oauth|session|token)(\/|$)/iu.test(route.routePath)
  ) {
    boundaries.push("auth");
  }
  if (/(^|\/)(webhook|callback|integration)(\/|$)/iu.test(route.routePath)) {
    boundaries.push("external-api");
  }
  return [...new Set(boundaries)];
}

function frameworkTitle(framework: ServerFramework): string {
  if (framework === "fastify") {
    return "Fastify";
  }
  if (framework === "hono") {
    return "Hono";
  }
  return "Express";
}

function uniqueRoutes(routes: ServerRoute[]): ServerRoute[] {
  const seen = new Set<string>();
  const output: ServerRoute[] = [];
  for (const route of routes) {
    const key = `${route.framework}:${route.filePath}:${route.method}:${route.routePath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(route);
  }
  return output;
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
