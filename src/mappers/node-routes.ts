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
    const scopedFastifyRoutes =
      framework === "fastify" ? fastifyScopedCallbackRoutes(source, filePath) : [];
    if (targets.size === 0 && scopedFastifyRoutes.length === 0) {
      continue;
    }
    routes.push(...directMethodRoutes(source, filePath, framework, targets));
    if (framework === "express") {
      routes.push(...expressRouteChains(source, filePath, targets));
    } else if (framework === "fastify") {
      routes.push(...fastifyRouteObjects(source, filePath, targets));
      routes.push(...scopedFastifyRoutes);
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
    const methods = readStringPropertyValues(routeObject, "method");
    const routePath =
      readStringProperty(routeObject, "url") ?? readStringProperty(routeObject, "path");
    if (methods.length === 0 || routePath === null || !isRoutePath(routePath)) {
      continue;
    }
    const symbol = readIdentifierProperty(routeObject, "handler");
    for (const method of methods) {
      routes.push({
        framework: "fastify",
        filePath,
        method: method.toUpperCase(),
        routePath,
        symbol,
      });
    }
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
    for (const factoryName of expressRouterFactoryNames(source)) {
      patterns.push(
        new RegExp(
          `${declarationPrefix}${escapeRegExp(factoryName)}${genericArguments}\\s*\\(`,
          "gu",
        ),
      );
    }
    return declaredTargetNames(source, patterns);
  }
  if (framework === "fastify") {
    return new Set([
      ...declaredTargetNames(source, [
        new RegExp(`${declarationPrefix}(?:Fastify|fastify)${genericArguments}\\s*\\(`, "gu"),
      ]),
      ...fastifyParameterTargets(source),
    ]);
  }
  return declaredTargetNames(source, [
    new RegExp(`${declarationPrefix}(?:new\\s+)?Hono${genericArguments}\\s*\\(`, "gu"),
  ]);
}

function expressRouterFactoryNames(source: string): Set<string> {
  return new Set([
    ...expressRouterImportBindingNames(source),
    ...expressRouterRequireBindingNames(source),
    ...expressRouterAssignmentNames(source),
  ]);
}

function expressRouterImportBindingNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /\bimport\b/gu;
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    const importIndex = match.index ?? 0;
    if (
      isInsideCommentOrString(source, importIndex) ||
      !isImportDeclarationStart(source, importIndex)
    ) {
      continue;
    }
    const clause = readExpressStaticImportClause(source, importIndex);
    if (clause !== null) {
      addExpressRouterImportNames(names, clause);
    }
  }
  return names;
}

function readExpressStaticImportClause(source: string, importIndex: number): string | null {
  let cursor = importIndex + "import".length;
  cursor = skipWhitespaceAndComments(source, cursor);
  if (
    source[cursor] === "(" ||
    source[cursor] === "." ||
    source[cursor] === "'" ||
    source[cursor] === '"' ||
    (source.startsWith("type", cursor) && !isIdentifierChar(source[cursor + "type".length]))
  ) {
    return null;
  }
  if (!isImportClauseStart(source[cursor])) {
    return null;
  }
  const clauseStart = cursor;
  const limit = Math.min(source.length, importIndex + 500);
  while (cursor < limit) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === undefined) {
      break;
    }
    if (char === ";") {
      return null;
    }
    if (char === "/" && next === "/") {
      cursor = skipLineComment(source, cursor + 2);
      continue;
    }
    if (char === "/" && next === "*") {
      cursor = skipBlockComment(source, cursor + 2);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(source, cursor, char);
      continue;
    }
    if (isKeywordAt(source, cursor, "from")) {
      const specifier = readImportSpecifier(source, cursor + "from".length);
      if (specifier === null) {
        cursor += "from".length;
        continue;
      }
      return specifier.value === "express" ? source.slice(clauseStart, cursor) : null;
    }
    cursor += 1;
  }
  return null;
}

function addExpressRouterImportNames(names: Set<string>, clause: string): void {
  const named = /\{([^}]*)\}/u.exec(clause)?.[1];
  if (named === undefined) {
    return;
  }
  for (const part of named.split(",")) {
    const binding = part.trim();
    if (binding.startsWith("type ")) {
      continue;
    }
    const match = /^Router(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/u.exec(binding);
    if (match !== null) {
      names.add(match[1] ?? "Router");
    }
  }
}

function expressRouterRequireBindingNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern =
    /\b(?:const|let|var)\s*\{\s*([^}]*)\}\s*=\s*require\s*\(\s*["']express["']\s*\)/gu;
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    if (isInsideCommentOrString(source, match.index ?? 0)) {
      continue;
    }
    addExpressRouterRequireNames(names, match[1] ?? "");
  }
  return names;
}

function addExpressRouterRequireNames(names: Set<string>, clause: string): void {
  for (const part of clause.split(",")) {
    const binding = part.trim();
    const match = /^Router(?:\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*))?$/u.exec(binding);
    if (match !== null) {
      names.add(match[1] ?? "Router");
    }
  }
}

function expressRouterAssignmentNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^=;]+)?\s*=\s*(?:express\s*\.\s*Router|require\s*\(\s*["']express["']\s*\)\s*\.\s*Router)\b/gu;
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    if (isInsideCommentOrString(source, match.index ?? 0)) {
      continue;
    }
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function fastifyParameterTargets(source: string): Set<string> {
  const names = new Set<string>();
  for (const callback of functionParameterCallbacks(source)) {
    for (const parameter of callback.parameters) {
      if (parameter.name === "fastify") {
        names.add(parameter.name);
      }
    }
  }
  return names;
}

function fastifyPluginCallTargetNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const clause of fastifyPluginImportClauses(source)) {
    addFastifyPluginImportNames(names, clause);
  }
  for (const pattern of [
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^=;]+)?\s*=\s*require\s*\(\s*["']fastify-plugin["']\s*\)(?:\s*\.\s*default)?/gu,
    /\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\s*\(\s*["']fastify-plugin["']\s*\)/gu,
  ]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (isInsideCommentOrString(source, match.index ?? 0)) {
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

function fastifyPluginImportClauses(source: string): string[] {
  const clauses: string[] = [];
  const pattern = /\bimport\b/gu;
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    const importIndex = match.index ?? 0;
    if (
      isInsideCommentOrString(source, importIndex) ||
      !isImportDeclarationStart(source, importIndex)
    ) {
      continue;
    }
    const clause = readStaticImportClause(source, importIndex, "fastify-plugin");
    if (clause !== null) {
      clauses.push(clause);
    }
  }
  return clauses;
}

function addFastifyPluginImportNames(names: Set<string>, clause: string): void {
  const namespace = /^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(clause.trim())?.[1];
  if (namespace !== undefined) {
    names.add(namespace);
    return;
  }

  const defaultName = /^([A-Za-z_$][A-Za-z0-9_$]*)\b/u.exec(clause.trim())?.[1];
  if (defaultName !== undefined && defaultName !== "type") {
    names.add(defaultName);
  }

  const named = /\{([^}]*)\}/u.exec(clause)?.[1];
  if (named === undefined) {
    return;
  }
  for (const part of named.split(",")) {
    const binding = part.trim();
    if (binding.startsWith("type ")) {
      continue;
    }
    const match = /^(?:default|fastifyPlugin)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/u.exec(
      binding,
    );
    if (match !== null) {
      names.add(match[1] ?? binding);
    }
  }
}

function fastifyInstanceTypeNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /\bimport\b/gu;
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    const importIndex = match.index ?? 0;
    if (
      isInsideCommentOrString(source, importIndex) ||
      !isImportDeclarationStart(source, importIndex)
    ) {
      continue;
    }
    const clause = readFastifyStaticImportClause(source, importIndex);
    if (clause !== null) {
      addFastifyInstanceTypeNames(names, clause);
    }
  }
  return names;
}

function addFastifyInstanceTypeNames(names: Set<string>, clause: string): void {
  const named = /\{([^}]*)\}/u.exec(clause)?.[1];
  if (named === undefined) {
    return;
  }
  for (const part of named.split(",")) {
    const binding = part.trim().replace(/^type\s+/u, "");
    const match = /^FastifyInstance(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/u.exec(binding);
    if (match !== null) {
      names.add(match[1] ?? "FastifyInstance");
    }
  }
}

function readFastifyStaticImportClause(source: string, importIndex: number): string | null {
  return readStaticImportClause(source, importIndex, "fastify");
}

function readStaticImportClause(
  source: string,
  importIndex: number,
  moduleName: string,
): string | null {
  let cursor = importIndex + "import".length;
  cursor = skipWhitespaceAndComments(source, cursor);
  if (
    source[cursor] === "(" ||
    source[cursor] === "." ||
    source[cursor] === "'" ||
    source[cursor] === '"'
  ) {
    return null;
  }
  if (!isImportClauseStart(source[cursor])) {
    return null;
  }
  const clauseStart = cursor;
  const limit = Math.min(source.length, importIndex + 500);
  while (cursor < limit) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === undefined) {
      break;
    }
    if (char === ";") {
      return null;
    }
    if (char === "/" && next === "/") {
      cursor = skipLineComment(source, cursor + 2);
      continue;
    }
    if (char === "/" && next === "*") {
      cursor = skipBlockComment(source, cursor + 2);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(source, cursor, char);
      continue;
    }
    if (isKeywordAt(source, cursor, "from")) {
      const specifier = readImportSpecifier(source, cursor + "from".length);
      if (specifier === null) {
        cursor += "from".length;
        continue;
      }
      return specifier.value === moduleName ? source.slice(clauseStart, cursor) : null;
    }
    cursor += 1;
  }
  return null;
}

function fastifyScopedCallbackRoutes(source: string, filePath: string): ServerRoute[] {
  const pluginCallTargets = fastifyPluginCallTargetNames(source);
  const instanceTypeNames = fastifyInstanceTypeNames(source);
  const routes: ServerRoute[] = [];
  for (const callback of [
    ...functionParameterCallbacks(source),
    ...inlineFastifyInstanceCallbacks(source),
  ]) {
    const targets = new Set<string>();
    for (const [index, parameter] of callback.parameters.entries()) {
      if (
        isFastifyInstanceParameter(parameter.source, instanceTypeNames) ||
        (pluginCallTargets.size > 0 &&
          index === 0 &&
          isInsideFastifyPluginCall(source, callback.index, pluginCallTargets))
      ) {
        targets.add(parameter.name);
      }
    }
    if (targets.size === 0) {
      continue;
    }
    const body = functionBodySource(source, callback.bodySearchStart);
    if (body === null) {
      continue;
    }
    routes.push(...directMethodRoutes(body, filePath, "fastify", targets));
    routes.push(...fastifyRouteObjects(body, filePath, targets));
  }
  return routes;
}

function inlineFastifyInstanceCallbacks(source: string): Array<{
  index: number;
  bodySearchStart: number;
  parameters: Array<{ name: string; source: string }>;
}> {
  const callbacks: Array<{
    index: number;
    bodySearchStart: number;
    parameters: Array<{ name: string; source: string }>;
  }> = [];
  const functionPattern =
    /(?:async\s+)?function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*import\s*\(\s*["']fastify["']\s*\)\s*\.\s*FastifyInstance\b[^)]*\)/gu;
  functionPattern.lastIndex = 0;
  for (const match of source.matchAll(functionPattern)) {
    const matchIndex = match.index ?? 0;
    addInlineFastifyInstanceCallback(callbacks, source, matchIndex, match[0].length, match[1]);
  }
  const arrowPattern =
    /(^|[^A-Za-z0-9_$])((?:async\s*)?\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*import\s*\(\s*["']fastify["']\s*\)\s*\.\s*FastifyInstance\b[^)]*\)\s*(?::\s*[^=]+?)?=>)/gu;
  arrowPattern.lastIndex = 0;
  for (const match of source.matchAll(arrowPattern)) {
    const prefixLength = match[1]?.length ?? 0;
    const callbackIndex = (match.index ?? 0) + prefixLength;
    addInlineFastifyInstanceCallback(
      callbacks,
      source,
      callbackIndex,
      match[2]?.length ?? 0,
      match[3],
    );
  }
  return callbacks;
}

function addInlineFastifyInstanceCallback(
  callbacks: Array<{
    index: number;
    bodySearchStart: number;
    parameters: Array<{ name: string; source: string }>;
  }>,
  source: string,
  callbackIndex: number,
  matchLength: number,
  name: string | undefined,
): void {
  if (name === undefined || isInsideCommentOrString(source, callbackIndex)) {
    return;
  }
  callbacks.push({
    index: callbackIndex,
    bodySearchStart: callbackIndex + matchLength,
    parameters: [
      {
        name,
        source: `${name}: import("fastify").FastifyInstance`,
      },
    ],
  });
}

function functionParameterCallbacks(source: string): Array<{
  index: number;
  bodySearchStart: number;
  parameters: Array<{ name: string; source: string }>;
}> {
  const callbacks: Array<{
    index: number;
    bodySearchStart: number;
    parameters: Array<{ name: string; source: string }>;
  }> = [];
  const functionPattern = /(?:async\s+)?function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(([^)]*)\)/gu;
  functionPattern.lastIndex = 0;
  for (const match of source.matchAll(functionPattern)) {
    const matchIndex = match.index ?? 0;
    addFunctionParameterCallback(callbacks, source, matchIndex, match[0].length, match[1]);
  }
  const arrowPattern = /(^|[^A-Za-z0-9_$])((?:async\s*)?\(([^()]*)\)\s*(?::\s*[^=]+?)?=>)/gu;
  arrowPattern.lastIndex = 0;
  for (const match of source.matchAll(arrowPattern)) {
    const prefixLength = match[1]?.length ?? 0;
    const callbackIndex = (match.index ?? 0) + prefixLength;
    addFunctionParameterCallback(callbacks, source, callbackIndex, match[2]?.length ?? 0, match[3]);
  }
  const bareArrowPattern = /(^|[^A-Za-z0-9_$])((?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*=>)/gu;
  bareArrowPattern.lastIndex = 0;
  for (const match of source.matchAll(bareArrowPattern)) {
    const prefixLength = match[1]?.length ?? 0;
    const callbackIndex = (match.index ?? 0) + prefixLength;
    addFunctionParameterCallback(callbacks, source, callbackIndex, match[2]?.length ?? 0, match[3]);
  }
  return callbacks;
}

function addFunctionParameterCallback(
  callbacks: Array<{
    index: number;
    bodySearchStart: number;
    parameters: Array<{ name: string; source: string }>;
  }>,
  source: string,
  callbackIndex: number,
  matchLength: number,
  parameters: string | undefined,
): void {
  if (isInsideCommentOrString(source, callbackIndex)) {
    return;
  }
  callbacks.push({
    index: callbackIndex,
    bodySearchStart: callbackIndex + matchLength,
    parameters: functionParameters(parameters ?? ""),
  });
}

function functionBodySource(source: string, bodySearchStart: number): string | null {
  let bodyStart = skipWhitespaceAndComments(source, bodySearchStart);
  if (source[bodyStart] === ":") {
    bodyStart = skipWhitespaceAndComments(source, skipFunctionReturnType(source, bodyStart + 1));
  }
  if (source[bodyStart] !== "{") {
    return null;
  }
  const bodyEnd = endOfObject(source, bodyStart + 1);
  return bodyEnd === null ? null : source.slice(bodyStart + 1, bodyEnd - 1);
}

function skipFunctionReturnType(source: string, start: number): number {
  let quote: string | null = null;
  let escaped = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) {
      return index;
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
    } else if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === "{") {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        const previous = previousSignificantChar(source, index - 1, start);
        if (
          previous !== ":" &&
          previous !== "|" &&
          previous !== "&" &&
          previous !== "," &&
          previous !== "<"
        ) {
          return index;
        }
      }
      braceDepth += 1;
    } else if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }
  return source.length;
}

function previousSignificantChar(source: string, start: number, lowerBound: number): string | null {
  for (let index = start; index >= lowerBound; index -= 1) {
    const char = source[index];
    if (char !== undefined && !/\s/u.test(char)) {
      return char;
    }
  }
  return ":";
}

function functionParameters(parameters: string): Array<{ name: string; source: string }> {
  return parameters
    .split(",")
    .map((parameter) => {
      const source = parameter.trim();
      const name = /^\.{0,3}\s*([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(source)?.[1];
      return name === undefined ? null : { name, source };
    })
    .filter((parameter): parameter is { name: string; source: string } => parameter !== null);
}

function isFastifyInstanceParameter(
  parameter: string,
  instanceTypeNames: ReadonlySet<string>,
): boolean {
  if (/:\s*import\s*\(\s*["']fastify["']\s*\)\s*\.\s*FastifyInstance\b/u.test(parameter)) {
    return true;
  }
  for (const name of instanceTypeNames) {
    if (new RegExp(String.raw`:\s*${escapeRegExp(name)}\b`, "u").test(parameter)) {
      return true;
    }
  }
  return false;
}

function isInsideFastifyPluginCall(
  source: string,
  functionIndex: number,
  pluginCallTargets: ReadonlySet<string>,
): boolean {
  const prefix = source
    .slice(Math.max(0, functionIndex - 500), functionIndex)
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\n\r]*/gu, " ");
  const targetPattern = [...pluginCallTargets].map(escapeRegExp).join("|");
  return new RegExp(`\\b(?:${targetPattern})${genericArguments}\\s*\\(\\s*$`, "u").test(prefix);
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

function isKeywordAt(source: string, index: number, keyword: string): boolean {
  return (
    source.startsWith(keyword, index) &&
    !isIdentifierChar(source[index - 1]) &&
    !isIdentifierChar(source[index + keyword.length])
  );
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/u.test(char);
}

function isImportClauseStart(char: string | undefined): boolean {
  return char !== undefined && (char === "{" || char === "*" || /[A-Za-z_$]/u.test(char));
}

function isImportDeclarationStart(source: string, importIndex: number): boolean {
  let cursor = importIndex - 1;
  while (cursor >= 0) {
    const char = source[cursor];
    if (char === " " || char === "\t" || char === "\r" || char === "\uFEFF") {
      cursor -= 1;
      continue;
    }
    if (char === "\n") {
      return true;
    }
    if (char === "/" && source[cursor - 1] === "*") {
      const open = source.lastIndexOf("/*", cursor - 2);
      if (open < 0) {
        return false;
      }
      if (source.slice(open, cursor + 1).includes("\n")) {
        return true;
      }
      cursor = open - 1;
      continue;
    }
    return char === ";";
  }
  return true;
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (/\s/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function skipWhitespaceAndComments(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    const next = skipWhitespace(source, cursor);
    if (source[next] === "/" && source[next + 1] === "*") {
      cursor = skipBlockComment(source, next + 2);
      continue;
    }
    if (source[next] === "/" && source[next + 1] === "/") {
      cursor = skipLineComment(source, next + 2);
      continue;
    }
    return next;
  }
  return cursor;
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline < 0 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const close = source.indexOf("*/", start);
  return close < 0 ? source.length : close + 2;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let cursor = start + 1;
  let escaped = false;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === undefined) {
      break;
    }
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      return cursor + 1;
    }
    cursor += 1;
  }
  return source.length;
}

function readImportSpecifier(source: string, start: number): { value: string; end: number } | null {
  let cursor = skipWhitespace(source, start);
  const quote = source[cursor];
  if (quote !== "'" && quote !== '"') {
    return null;
  }
  cursor += 1;
  let value = "";
  let escaped = false;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === undefined) {
      break;
    }
    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      return { value, end: cursor + 1 };
    } else {
      value += char;
    }
    cursor += 1;
  }
  return null;
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
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline;
    } else if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 1;
    } else if (char === "'" || char === '"' || char === "`") {
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

function endOfArray(source: string, start: number): number | null {
  const stack = ["["];
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
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "[" || char === "(" || char === "{") {
      stack.push(char);
    } else if (char === "]" || char === ")" || char === "}") {
      const opener = stack.at(-1);
      if (
        (opener === "[" && char === "]") ||
        (opener === "(" && char === ")") ||
        (opener === "{" && char === "}")
      ) {
        stack.pop();
        if (stack.length === 0) {
          return index + 1;
        }
      } else {
        return null;
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

function readStringPropertyValues(source: string, property: string): string[] {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(String.raw`(?:^|[,{}]\s*)${escapedProperty}\s*:`, "gu");
  for (const match of source.matchAll(pattern)) {
    const valueStart = (match.index ?? 0) + match[0].length;
    const literal = readStringLiteralArgument(source, valueStart);
    if (literal !== null) {
      const delimiter = nextRoutePropertyDelimiter(source, literal.end);
      if (delimiter === "," || delimiter === "}") {
        return [literal.value];
      }
      continue;
    }
    const array = readStringArrayLiteral(source, valueStart);
    if (array === null) {
      continue;
    }
    const delimiter = nextRoutePropertyDelimiter(source, array.end);
    if (delimiter === "," || delimiter === "}") {
      return array.values;
    }
  }
  return [];
}

function readStringArrayLiteral(
  source: string,
  start: number,
): { values: string[]; end: number } | null {
  const arrayStart = skipWhitespace(source, start);
  if (source[arrayStart] !== "[") {
    return null;
  }
  const arrayEnd = endOfArray(source, arrayStart + 1);
  if (arrayEnd === null) {
    return null;
  }
  const values: string[] = [];
  for (const element of splitTopLevelArguments(source.slice(arrayStart + 1, arrayEnd - 1))) {
    const literal = readStringLiteralArgument(element, 0);
    if (literal === null) {
      continue;
    }
    const delimiter = nextRouteValueDelimiter(element, literal.end);
    if (delimiter === null) {
      values.push(literal.value);
    }
  }
  return { values, end: arrayEnd };
}

function readStringProperty(source: string, property: string): string | null {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(String.raw`(?:^|[,{]\s*)${escapedProperty}\s*:`, "gu");
  for (const match of source.matchAll(pattern)) {
    const literal = readStringLiteralArgument(source, (match.index ?? 0) + match[0].length);
    if (literal === null) {
      continue;
    }
    const delimiter = nextRoutePropertyDelimiter(source, literal.end);
    if (delimiter === "," || delimiter === "}") {
      return literal.value;
    }
  }
  return null;
}

function nextRoutePropertyDelimiter(source: string, start: number): string | null {
  const suffixEnd = skipTypeScriptValueSuffix(source, start);
  return nextRouteValueDelimiter(source, suffixEnd);
}

function skipTypeScriptValueSuffix(source: string, start: number): number {
  let cursor = skipWhitespaceAndComments(source, start);
  if (isKeywordAt(source, cursor, "as")) {
    cursor = skipWhitespaceAndComments(source, cursor + "as".length);
    if (isKeywordAt(source, cursor, "const")) {
      return skipWhitespaceAndComments(source, cursor + "const".length);
    }
    return start;
  }
  if (isKeywordAt(source, cursor, "satisfies")) {
    return skipTypeSuffix(source, cursor + "satisfies".length);
  }
  return start;
}

function skipTypeSuffix(source: string, start: number): number {
  let quote: string | null = null;
  let escaped = false;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) {
      return index;
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
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return index;
    }
  }
  return source.length;
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
