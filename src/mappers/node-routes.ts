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
const rootEntryNames = ["server", "app", "index", "main", "api"] as const;
const rootEntryFiles = rootEntryNames.flatMap((name) =>
  sourceExtensions.map((extension) => `${name}.${extension}`),
);
const rootEntryTestFiles = rootEntryNames.flatMap((name) =>
  sourceExtensions.flatMap((extension) => [
    `${name}.test.${extension}`,
    `${name}.spec.${extension}`,
  ]),
);
const testRoots = ["src", "lib", "app", "server", "routes", "api", "test", "tests", "__tests__"];
const routeMethods = ["get", "post", "put", "patch", "delete", "options", "head", "all"] as const;
const declarationPrefix = String.raw`\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^=;]+)?\s*=\s*`;
const genericArguments = String.raw`(?:\s*<[^;=()]*>)?`;
const regexPrefixKeywords = new Set([
  "await",
  "case",
  "delete",
  "else",
  "in",
  "instanceof",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const routeMethodPattern = new RegExp(
  `(^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*)\\s*\\.\\s*(${routeMethods.join("|")})${genericArguments}\\s*\\(`,
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
      frameworks.length > 0 ? frameworks : project.packageJson === null ? rootFrameworks : [];
    if (effectiveFrameworks.length === 0) {
      continue;
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
  const files = await packageSourceFiles(root, project, context.projects);
  const tests = await packageTestFiles(root, project, context.projects);
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
    } else if (framework === "fastify") {
      routes.push(...fastifyRouteObjects(source, filePath, targets));
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
    const delimiter = nextRouteValueDelimiter(source, routePath.end);
    if (delimiter !== "," && delimiter !== ")") {
      continue;
    }
    const callEnd = endOfCall(source, openParenIndex + 1);
    routes.push({
      framework,
      filePath,
      method: method.toUpperCase(),
      routePath: routePath.value,
      symbol: callEnd === null ? null : readHandlerSymbol(source, routePath.end, callEnd - 1),
    });
  }
  return routes;
}

function fastifyRouteObjects(
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
    const objectStart = skipWhitespace(source, openParenIndex + 1);
    if (source[objectStart] !== "{") {
      continue;
    }
    const objectEnd = endOfObject(source, objectStart + 1);
    if (objectEnd === null) {
      continue;
    }
    const routeObject = source.slice(objectStart, objectEnd);
    const method = readStringProperty(routeObject, "method");
    const routePath =
      readStringProperty(routeObject, "url") ?? readStringProperty(routeObject, "path");
    if (method === null || routePath === null || !isRoutePath(routePath)) {
      continue;
    }
    routes.push({
      framework: "fastify",
      filePath,
      method: method.toUpperCase(),
      routePath,
      symbol: readIdentifierProperty(routeObject, "handler"),
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
    const delimiter = nextRouteValueDelimiter(source, routePath.end);
    if (delimiter !== "," && delimiter !== ")") {
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
    const patterns = [
      new RegExp(
        `${declarationPrefix}(?:express${genericArguments}\\s*\\(|express\\s*\\.\\s*Router${genericArguments}\\s*\\()`,
        "gu",
      ),
    ];
    if (hasExpressRouterBinding(source)) {
      patterns.push(new RegExp(`${declarationPrefix}Router${genericArguments}\\s*\\(`, "gu"));
    }
    return declaredTargetNames(source, patterns);
  }
  if (framework === "fastify") {
    return new Set([
      ...declaredTargetNames(source, [
        new RegExp(`${declarationPrefix}(?:Fastify|fastify)${genericArguments}\\s*\\(`, "gu"),
      ]),
      ...functionParameterTargets(source, "fastify"),
    ]);
  }
  return declaredTargetNames(source, [
    new RegExp(`${declarationPrefix}(?:new\\s+)?Hono${genericArguments}\\s*\\(`, "gu"),
  ]);
}

function hasExpressRouterBinding(source: string): boolean {
  return (
    hasExpressRouterImportBinding(source) ||
    codePatternMatches(
      source,
      /\b(?:const|let|var)\s*\{\s*[^}]*\bRouter\b[^}]*\}\s*=\s*require\s*\(\s*["']express["']\s*\)/gu,
    ) ||
    codePatternMatches(
      source,
      /\b(?:const|let|var)\s+Router\s*=\s*(?:express\s*\.\s*Router|require\s*\(\s*["']express["']\s*\)\s*\.\s*Router)\b/gu,
    )
  );
}

function hasExpressRouterImportBinding(source: string): boolean {
  const pattern = /\bimport\s+(?!type\b)([\s\S]{0,400}?)\bfrom\s*["']express["']/gu;
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    if (isInsideCommentOrString(source, match.index ?? 0)) {
      continue;
    }
    if (importClauseHasBareValueRouter(match[1] ?? "")) {
      return true;
    }
  }
  return false;
}

function importClauseHasBareValueRouter(clause: string): boolean {
  const named = /\{([^}]*)\}/u.exec(clause)?.[1];
  if (named === undefined) {
    return false;
  }
  return named.split(",").some((part) => {
    const binding = part.trim();
    return !binding.startsWith("type ") && /^Router(?:\s+as\s+Router)?$/u.test(binding);
  });
}

function codePatternMatches(source: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    if (!isInsideCommentOrString(source, match.index ?? 0)) {
      return true;
    }
  }
  return false;
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

function functionParameterTargets(source: string, preferredName: string): Set<string> {
  const names = new Set<string>();
  for (const pattern of [
    /(?:async\s+)?function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(([^)]*)\)/gu,
    /(?:async\s*)?\(([^)]*)\)\s*=>/gu,
  ]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const matchIndex = match.index ?? 0;
      if (isInsideCommentOrString(source, matchIndex)) {
        continue;
      }
      for (const parameter of parameterNames(match[1] ?? "")) {
        if (parameter === preferredName) {
          names.add(parameter);
        }
      }
    }
  }
  return names;
}

function parameterNames(parameters: string): string[] {
  return parameters
    .split(",")
    .map((parameter) => /^\.{0,3}\s*([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(parameter.trim())?.[1])
    .filter((parameter): parameter is string => parameter !== undefined);
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

function nextRouteValueDelimiter(source: string, start: number): string | null {
  let cursor = start;
  while (cursor < source.length) {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === "/" && source[cursor + 1] === "/") {
      const newline = source.indexOf("\n", cursor + 2);
      if (newline < 0) {
        return null;
      }
      cursor = newline + 1;
      continue;
    }
    if (source[cursor] === "/" && source[cursor + 1] === "*") {
      const close = source.indexOf("*/", cursor + 2);
      if (close < 0) {
        return null;
      }
      cursor = close + 2;
      continue;
    }
    return source[cursor] ?? null;
  }
  return null;
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

function endOfObject(source: string, start: number): number | null {
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
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
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

function readStringProperty(source: string, property: string): string | null {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(String.raw`(?:^|[,{]\s*)${escapedProperty}\s*:`, "gu");
  for (const match of source.matchAll(pattern)) {
    const literal = readStringLiteralArgument(source, (match.index ?? 0) + match[0].length);
    if (literal === null) {
      continue;
    }
    const delimiter = nextRouteValueDelimiter(source, literal.end);
    if (delimiter === "," || delimiter === "}") {
      return literal.value;
    }
  }
  return null;
}

function readIdentifierProperty(source: string, property: string): string | null {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    String.raw`(?:^|[,{]\s*)${escapedProperty}\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)`,
    "u",
  ).exec(source);
  return normalizeHandlerSymbol(match?.[1] ?? null);
}

function readHandlerSymbol(source: string, start: number, end: number): string | null {
  const args = splitTopLevelArguments(source.slice(start, end));
  const lastArg = args.at(-1);
  const match =
    lastArg === undefined
      ? null
      : /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?$/u.exec(lastArg.trim());
  return normalizeHandlerSymbol(match?.[0] ?? null);
}

function splitTopLevelArguments(source: string): string[] {
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
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
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      args.push(source.slice(start, index));
      start = index + 1;
    }
  }
  args.push(source.slice(start));
  return args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
}

function normalizeHandlerSymbol(symbol: string | null): string | null {
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
  const previousSegment = source.slice(0, index).trimEnd();
  if (previousSegment.endsWith("=>")) {
    return true;
  }
  const previousWord = /([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(previousSegment)?.[1] ?? null;
  if (previousWord !== null && regexPrefixKeywords.has(previousWord)) {
    return true;
  }
  const previous = previousSegment.at(-1) ?? null;
  return previous === null || /[([{=,:;!&|?*~^]/u.test(previous);
}

async function packageSourceFiles(
  root: string,
  project: NodeProjectInfo,
  projects: NodeProjectInfo[],
): Promise<string[]> {
  const prefixes = [
    ...sourceRoots.map((prefix) => packageRelativePath(project.root, prefix)),
    ...(project.sourceRoot === null ? [] : [project.sourceRoot]),
    ...rootEntryFiles.map((file) => packageRelativePath(project.root, file)),
  ];
  const nestedRoots = nestedProjectRoots(project, projects);
  return (await walk(root, prefixes))
    .filter((file) => pathMatchesPrefix(file, project.root === "." ? "" : project.root))
    .filter((file) => !nestedRoots.some((nestedRoot) => pathMatchesPrefix(file, nestedRoot)))
    .filter(isReviewableServerSourceFile);
}

async function packageTestFiles(
  root: string,
  project: NodeProjectInfo,
  projects: NodeProjectInfo[],
): Promise<string[]> {
  const prefixes = [
    ...testRoots.map((prefix) => packageRelativePath(project.root, prefix)),
    ...(project.sourceRoot === null ? [] : [project.sourceRoot]),
    ...rootEntryTestFiles.map((file) => packageRelativePath(project.root, file)),
  ];
  const nestedRoots = nestedProjectRoots(project, projects);
  return (await walk(root, prefixes))
    .filter((file) => !nestedRoots.some((nestedRoot) => pathMatchesPrefix(file, nestedRoot)))
    .filter(isNodeTestPath)
    .slice(0, 200);
}

function nestedProjectRoots(project: NodeProjectInfo, projects: NodeProjectInfo[]): string[] {
  return projects
    .map((candidate) => candidate.root)
    .filter(
      (candidateRoot) =>
        candidateRoot !== "." &&
        candidateRoot !== project.root &&
        pathMatchesPrefix(candidateRoot, project.root === "." ? "" : project.root),
    )
    .toSorted((left, right) => right.length - left.length);
}

function associatedTests(files: string[], tests: string[], command: string | null): SeedTestRef[] {
  const dirs = new Set(files.map((file) => dirname(file)));
  const exact = tests.filter((test) => files.some((file) => isExactTestForFile(file, test)));
  const candidates =
    exact.length > 0
      ? exact
      : tests.filter((test) => [...dirs].some((dir) => pathMatchesPrefix(test, dir)));
  return candidates.slice(0, 8).map((path) => ({ path, command }));
}

function isExactTestForFile(file: string, test: string): boolean {
  const fileStem = basename(file).replace(/\.[^.]+$/u, "");
  const testStem = basename(test).replace(/\.(test|spec)\.[^.]+$/u, "");
  if (fileStem !== testStem) {
    return false;
  }
  return fileStem !== "index" || dirname(file) === dirname(test);
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
