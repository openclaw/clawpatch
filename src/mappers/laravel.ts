import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  composerDependencyNames,
  composerScripts,
  readComposerJson,
  type ComposerJson,
} from "../detect.js";
import { pathExists } from "../fs.js";
import { TrustBoundary } from "../types.js";
import { isSafeDirectory, isSafeFile, pathMatchesPrefix, shouldSkip, walk } from "./shared.js";
import { FeatureSeed, SeedFileRef, SeedTestRef } from "./types.js";

type SourceGroup = {
  label: string;
  files: string[];
};

type RouteRef = {
  file: string;
  method: string;
  uri: string;
  controllerClass: string;
  action: string | null;
};

const composerScriptNames = [
  "setup",
  "dev",
  "test",
  "typecheck",
  "lint",
  "format",
  "analyse",
  "analyze",
];
const groupedMaxOwnedFiles = 12;
const maxAssociatedTests = 8;

export async function laravelSeeds(root: string): Promise<FeatureSeed[]> {
  const composer = await readComposerJson(root);
  const isLaravel = await isLaravelProject(root, composer);
  if (!isLaravel && composer === null) {
    return [];
  }

  const testCommand = await laravelTestCommand(root, composer);
  const testFiles = await phpTestFiles(root);
  const routes = await laravelRoutes(root);
  const seeds: FeatureSeed[] = [
    ...(isLaravel ? await projectSeeds(root, composer) : []),
    ...composerScriptSeeds(composer),
    ...(isLaravel ? await controllerSeeds(root, routes, testFiles, testCommand) : []),
    ...(isLaravel ? await requestSeeds(root, testFiles, testCommand) : []),
    ...(isLaravel ? await commandSeeds(root, testFiles, testCommand) : []),
    ...(isLaravel ? await jobSeeds(root, testFiles, testCommand) : []),
    ...(isLaravel ? await serviceSeeds(root, testFiles, testCommand) : []),
    ...(isLaravel ? await modelSeeds(root, testFiles, testCommand) : []),
    ...(isLaravel
      ? await groupedPhpSeeds(root, "database/migrations", "Laravel migrations", "migration")
      : []),
    ...(isLaravel
      ? await groupedPhpSeeds(root, "database/seeders", "Laravel seeders", "seeder")
      : []),
    ...testSuiteSeeds(testFiles, testCommand, isLaravel ? "Laravel" : "PHP"),
  ];

  return seeds;
}

async function isLaravelProject(root: string, composer: ComposerJson | null): Promise<boolean> {
  return (
    composerDependencyNames(composer).has("laravel/framework") ||
    (await pathExists(join(root, "artisan")))
  );
}

async function projectSeeds(root: string, composer: ComposerJson | null): Promise<FeatureSeed[]> {
  const ownedFiles: SeedFileRef[] = [];
  for (const path of ["composer.json", "composer.lock", "artisan", "bootstrap/app.php"]) {
    if (await pathExists(join(root, path))) {
      ownedFiles.push({ path, reason: "Laravel project metadata" });
    }
  }
  if (ownedFiles.length === 0) {
    return [];
  }
  const name =
    typeof composer?.name === "string"
      ? (composer.name.split("/").at(-1) ?? composer.name)
      : basename(root);
  return [
    {
      title: `Laravel project ${name}`,
      summary: `Laravel project metadata in ${ownedFiles.map((file) => file.path).join(", ")}.`,
      kind: "service",
      source: "laravel-project",
      confidence: "high",
      entryPath: ownedFiles[0]?.path ?? "composer.json",
      symbol: name,
      route: null,
      command: null,
      ownedFiles,
      contextFiles: await existingRefs(root, [
        ["phpunit.xml", "Laravel test configuration"],
        [".env.example", "environment contract"],
        ["config/app.php", "application config"],
        ["config/database.php", "database config"],
        ["routes/web.php", "HTTP routes"],
        ["routes/api.php", "API routes"],
        ["routes/console.php", "scheduled commands"],
      ]),
      tags: ["php", "laravel", "project"],
      trustBoundaries: ["filesystem", "database", "process-exec", "secrets"],
      skipNearbyTests: true,
    },
  ];
}

function composerScriptSeeds(composer: ComposerJson | null): FeatureSeed[] {
  return Object.entries(composerScripts(composer))
    .filter(([script]) => composerScriptNames.includes(script) || script.startsWith("deploy"))
    .map(([script, command]) => ({
      title: `Composer script ${script}`,
      summary: `Composer script '${script}': ${command}`,
      kind: script === "test" ? "test-suite" : "release",
      source: "composer-script",
      confidence: "medium",
      entryPath: "composer.json",
      symbol: script,
      route: null,
      command: script,
      ownedFiles: [{ path: "composer.json", reason: "composer script" }],
      contextFiles: [],
      tests: script === "test" ? [{ path: "composer.json", command: "composer test" }] : [],
      tags: ["php", "composer", "script"],
      trustBoundaries: script === "test" ? [] : (["process-exec", "filesystem"] as TrustBoundary[]),
      skipNearbyTests: true,
    }));
}

async function controllerSeeds(
  root: string,
  routes: RouteRef[],
  testFiles: string[],
  testCommand: string | null,
): Promise<FeatureSeed[]> {
  const controllerFiles = await phpFilesUnder(root, "app/Http/Controllers");
  const controllerByClass = new Map(controllerFiles.map((path) => [basename(path, ".php"), path]));
  return Promise.all(
    controllerFiles.map(async (path) => {
      const className = basename(path, ".php");
      const declaredClassName = await phpDeclaredClassName(root, path);
      const controllerRoutes = routes.filter((route) =>
        route.controllerClass.includes("\\")
          ? route.controllerClass === declaredClassName
          : route.controllerClass === className,
      );
      const tests = associatedPhpTests([path], testFiles, testCommand);
      return {
        title: `Laravel controller ${className}`,
        summary:
          controllerRoutes.length > 0
            ? `Laravel HTTP controller for ${describeRoutes(controllerRoutes)}.`
            : `Laravel HTTP controller ${className}.`,
        kind: "route",
        source: "laravel-controller",
        confidence: "high",
        entryPath: path,
        identityKey: declaredClassName ?? className,
        symbol: className,
        route: controllerRoutes[0]?.uri ?? null,
        command: null,
        ownedFiles: [{ path, reason: "controller" }],
        contextFiles: uniqueRefs([
          ...controllerRoutes.map((route) => ({ path: route.file, reason: "route definition" })),
          ...(await phpUseContextFiles(root, path, controllerByClass)),
          ...tests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests,
        tags: ["php", "laravel", "controller", "http"],
        trustBoundaries: ["user-input", "auth", "database", "serialization"],
        testCommand,
        skipNearbyTests: true,
      } satisfies FeatureSeed;
    }),
  );
}

async function requestSeeds(
  root: string,
  testFiles: string[],
  testCommand: string | null,
): Promise<FeatureSeed[]> {
  return phpClassSeeds(
    root,
    "app/Http/Requests",
    "Laravel request",
    "laravel-request",
    "route",
    ["php", "laravel", "request", "validation"],
    ["user-input", "auth"],
    testFiles,
    testCommand,
  );
}

async function commandSeeds(
  root: string,
  testFiles: string[],
  testCommand: string | null,
): Promise<FeatureSeed[]> {
  const files = await phpFilesUnder(root, "app/Console/Commands");
  return Promise.all(
    files.map(async (path) => {
      const className = basename(path, ".php");
      const signature = await artisanSignature(root, path);
      const tests = associatedPhpTests([path], testFiles, testCommand);
      return {
        title: `Laravel command ${signature ?? className}`,
        summary:
          signature === null
            ? `Laravel Artisan command ${className}.`
            : `Laravel Artisan command '${signature}' in ${path}.`,
        kind: "cli-command",
        source: "laravel-artisan-command",
        confidence: "high",
        entryPath: path,
        symbol: className,
        route: null,
        command: signature,
        ownedFiles: [{ path, reason: "Artisan command" }],
        contextFiles: uniqueRefs([
          ...(await phpUseContextFiles(root, path)),
          ...tests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests,
        tags: ["php", "laravel", "artisan", "cli"],
        trustBoundaries: ["user-input", "filesystem", "process-exec", "database"],
        testCommand,
        skipNearbyTests: true,
      } satisfies FeatureSeed;
    }),
  );
}

async function jobSeeds(
  root: string,
  testFiles: string[],
  testCommand: string | null,
): Promise<FeatureSeed[]> {
  return phpClassSeeds(
    root,
    "app/Jobs",
    "Laravel job",
    "laravel-job",
    "job",
    ["php", "laravel", "job"],
    ["database", "concurrency", "external-api"],
    testFiles,
    testCommand,
  );
}

async function serviceSeeds(
  root: string,
  testFiles: string[],
  testCommand: string | null,
): Promise<FeatureSeed[]> {
  const files = await phpFilesUnder(root, "app/Services");
  return Promise.all(
    files.map(async (path) => {
      const className = basename(path, ".php");
      const tests = associatedPhpTests([path], testFiles, testCommand);
      return {
        title: `Laravel service ${className}`,
        summary: `Laravel application service ${className}.`,
        kind: "service",
        source: "laravel-service",
        confidence: "medium",
        entryPath: path,
        symbol: className,
        route: null,
        command: null,
        ownedFiles: [{ path, reason: "service" }],
        contextFiles: uniqueRefs([
          ...(await phpUseContextFiles(root, path)),
          ...tests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests,
        tags: ["php", "laravel", "service"],
        trustBoundaries: trustBoundariesForName(className),
        testCommand,
        skipNearbyTests: true,
      } satisfies FeatureSeed;
    }),
  );
}

async function modelSeeds(
  root: string,
  testFiles: string[],
  testCommand: string | null,
): Promise<FeatureSeed[]> {
  return phpClassSeeds(
    root,
    "app/Models",
    "Laravel model",
    "laravel-model",
    "service",
    ["php", "laravel", "model", "eloquent"],
    ["database", "serialization"],
    testFiles,
    testCommand,
  );
}

async function phpClassSeeds(
  root: string,
  prefix: string,
  titlePrefix: string,
  source: string,
  kind: FeatureSeed["kind"],
  tags: string[],
  trustBoundaries: TrustBoundary[],
  testFiles: string[],
  testCommand: string | null,
): Promise<FeatureSeed[]> {
  const files = await phpFilesUnder(root, prefix);
  return Promise.all(
    files.map(async (path) => {
      const className = basename(path, ".php");
      const tests = associatedPhpTests([path], testFiles, testCommand);
      return {
        title: `${titlePrefix} ${className}`,
        summary: `${titlePrefix} ${className} in ${path}.`,
        kind,
        source,
        confidence: "medium",
        entryPath: path,
        symbol: className,
        route: null,
        command: null,
        ownedFiles: [{ path, reason: titlePrefix.toLowerCase() }],
        contextFiles: uniqueRefs([
          ...(await phpUseContextFiles(root, path)),
          ...tests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests,
        tags,
        trustBoundaries,
        testCommand,
        skipNearbyTests: true,
      } satisfies FeatureSeed;
    }),
  );
}

async function groupedPhpSeeds(
  root: string,
  prefix: string,
  titlePrefix: string,
  tag: string,
): Promise<FeatureSeed[]> {
  const files = await phpFilesUnder(root, prefix);
  const groups = partitionSourceFiles(prefix, files, groupedMaxOwnedFiles);
  return groups.map((group) => ({
    title: `${titlePrefix} ${group.label}`,
    summary: `${titlePrefix} in ${group.label}.`,
    kind: "infra",
    source: `laravel-${tag}`,
    confidence: "medium",
    entryPath: group.label,
    symbol: group.label,
    route: null,
    command: null,
    ownedFiles: group.files.map((path) => ({ path, reason: tag })),
    contextFiles: [],
    tests: [],
    tags: ["php", "laravel", tag],
    trustBoundaries: ["database"],
    skipNearbyTests: true,
  }));
}

async function laravelRoutes(root: string): Promise<RouteRef[]> {
  const routeFiles = await phpFilesUnder(root, "routes");
  const routes: RouteRef[] = [];
  for (const file of routeFiles) {
    const source = stripPhpComments(await readFile(join(root, file), "utf8"));
    const imports = phpUseMap(source);
    for (const match of source.matchAll(
      /Route::((?:[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*?\)\s*->\s*)*)(get|post|put|patch|delete|options|any|resource|apiResource)\s*\(\s*(['"])([^'"]*)\3\s*,\s*(?:\[\s*)?(\\?[A-Za-z_][A-Za-z0-9_\\]*)::class(?:\s*,\s*(['"])([^'"]+)\6)?/gmsu,
    )) {
      const chain = match[1] ?? "";
      const method = match[2];
      const uri = match[4];
      const controllerClass = resolveImportedClassName(imports, match[5] ?? "");
      if (method === undefined || uri === undefined || controllerClass === null) {
        continue;
      }
      routes.push({
        file,
        method,
        uri: routeUriWithPrefixes(
          [...fileDefaultRoutePrefixes(file), ...fluentRoutePrefixes(chain)],
          uri,
        ),
        controllerClass,
        action: match[7] ?? null,
      });
    }
    routes.push(...controllerGroupRoutes(file, source, imports));
  }
  return routes;
}

function controllerGroupRoutes(
  file: string,
  source: string,
  imports: Map<string, string>,
): RouteRef[] {
  const routes: RouteRef[] = [];
  for (const group of source.matchAll(
    /Route::((?:[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*?\)\s*->\s*)*)controller\s*\(\s*(\\?[A-Za-z_][A-Za-z0-9_\\]*)::class\s*\)\s*->\s*((?:[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*?\)\s*->\s*)*)group\s*\(\s*function\s*\([^)]*\)\s*\{(?<body>.*?)\}\s*\)\s*;/gmsu,
  )) {
    const controllerClass = resolveImportedClassName(imports, group[2] ?? "");
    const body = group.groups?.["body"];
    if (controllerClass === null || body === undefined) {
      continue;
    }
    const groupPrefixes = [
      ...fileDefaultRoutePrefixes(file),
      ...fluentRoutePrefixes(group[1] ?? ""),
      ...fluentRoutePrefixes(group[3] ?? ""),
    ];
    for (const route of body.matchAll(
      /Route::((?:[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*?\)\s*->\s*)*)(get|post|put|patch|delete|options|any)\s*\(\s*(['"])([^'"]*)\3\s*,\s*(['"])([^'"]+)\5/gmsu,
    )) {
      const method = route[2];
      const uri = route[4];
      if (method === undefined || uri === undefined) {
        continue;
      }
      routes.push({
        file,
        method,
        uri: routeUriWithPrefixes([...groupPrefixes, ...fluentRoutePrefixes(route[1] ?? "")], uri),
        controllerClass,
        action: route[6] ?? null,
      });
    }
  }
  return routes;
}

function fileDefaultRoutePrefixes(file: string): string[] {
  return file === "routes/api.php" ? ["api"] : [];
}

function fluentRoutePrefixes(chain: string): string[] {
  return [...chain.matchAll(/\bprefix\s*\(\s*(['"])([^'"]*)\1\s*\)/gmu)]
    .map((match) => match[2])
    .filter((prefix) => prefix !== undefined);
}

function stripPhpComments(source: string): string {
  let output = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === undefined) {
      continue;
    }
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
    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      continue;
    }
    if ((char === "/" && next === "/") || (char === "#" && next !== "[")) {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      if (source[index] === "\n") {
        output += "\n";
      }
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") {
          output += "\n";
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function phpUseMap(source: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(
    /^\s*use\s+([A-Za-z_\\][A-Za-z0-9_\\]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;/gimu,
  )) {
    const qualified = match[1];
    const short = match[2] ?? qualified?.split("\\").at(-1);
    if (qualified !== undefined && short !== undefined) {
      imports.set(short, qualified);
    }
  }
  for (const match of source.matchAll(
    /^\s*use\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\\\s*\{\s*([^}]+)\s*\}\s*;/gimu,
  )) {
    const prefix = match[1];
    const members = match[2];
    if (prefix === undefined || members === undefined) {
      continue;
    }
    for (const member of members.split(",")) {
      const memberMatch =
        /^\s*([A-Za-z_\\][A-Za-z0-9_\\]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$/iu.exec(member);
      const memberName = memberMatch?.[1];
      if (memberName === undefined) {
        continue;
      }
      const qualified = `${prefix}\\${memberName}`;
      const short = memberMatch?.[2] ?? memberName.split("\\").at(-1);
      if (short !== undefined) {
        imports.set(short, qualified);
      }
    }
  }
  return imports;
}

function resolveImportedClassName(imports: Map<string, string>, className: string): string | null {
  const normalized = className.replace(/^\\/u, "");
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.includes("\\")) {
    const [head, ...tail] = normalized.split("\\");
    const imported = head === undefined ? undefined : imports.get(head);
    if (imported !== undefined && tail.length > 0) {
      return `${imported}\\${tail.join("\\")}`;
    }
    return normalized;
  }
  return imports.get(normalized) ?? normalized;
}

async function phpDeclaredClassName(root: string, path: string): Promise<string> {
  const source = await readFile(join(root, path), "utf8");
  const className = basename(path, ".php");
  const namespace = /^\s*namespace\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*;/mu.exec(source)?.[1];
  return namespace === undefined ? className : `${namespace}\\${className}`;
}

function routeUri(uri: string): string {
  if (uri === "/" || uri.length === 0) {
    return "/";
  }
  return uri.startsWith("/") ? uri : `/${uri}`;
}

function routeUriWithPrefixes(prefixes: string[], uri: string): string {
  const combined = [...prefixes, uri]
    .map((segment) => segment.replace(/^\/+|\/+$/gu, ""))
    .filter((segment) => segment.length > 0)
    .join("/");
  return routeUri(combined);
}

function describeRoutes(routes: RouteRef[]): string {
  return routes
    .slice(0, 6)
    .map(
      (route) =>
        `${route.method.toUpperCase()} ${route.uri}${route.action ? `#${route.action}` : ""}`,
    )
    .join(", ");
}

async function artisanSignature(root: string, path: string): Promise<string | null> {
  const source = stripPhpComments(await readFile(join(root, path), "utf8"));
  return (
    /\$signature\s*=\s*(['"])([^'"]+)\1/u.exec(source)?.[2]?.split(/\s+/u)[0] ??
    /Signature\s*\(\s*(['"])([^'"]+)\1/u.exec(source)?.[2]?.split(/\s+/u)[0] ??
    /AsCommand\s*\(\s*name:\s*(['"])([^'"]+)\1/u.exec(source)?.[2] ??
    null
  );
}

async function phpUseContextFiles(
  root: string,
  path: string,
  alreadyKnownClasses = new Map<string, string>(),
): Promise<SeedFileRef[]> {
  const source = await readFile(join(root, path), "utf8");
  const refs: SeedFileRef[] = [];
  for (const qualified of phpUseMap(source).values()) {
    if (!qualified.startsWith("App\\")) {
      continue;
    }
    const candidate = `${qualified.replace(/\\/gu, "/")}.php`.replace(/^App\//u, "app/");
    if (candidate !== path && (await isSafeFile(root, join(root, candidate)))) {
      refs.push({ path: candidate, reason: "imported application class" });
      continue;
    }
    const short = qualified.split("\\").at(-1);
    const known = short === undefined ? undefined : alreadyKnownClasses.get(short);
    if (known !== undefined && known !== path) {
      refs.push({ path: known, reason: "imported application class" });
    }
  }
  return refs.slice(0, 12);
}

async function laravelTestCommand(
  root: string,
  composer: ComposerJson | null,
): Promise<string | null> {
  if (composerScripts(composer)["test"] !== undefined) {
    return "composer test";
  }
  if (await pathExists(join(root, "artisan"))) {
    return "php artisan test";
  }
  if (composerDependencyNames(composer).has("pestphp/pest")) {
    return "vendor/bin/pest";
  }
  if (
    composerDependencyNames(composer).has("phpunit/phpunit") ||
    composerDependencyNames(composer).has("phpunit/phpunit-selenium") ||
    (await pathExists(join(root, "phpunit.xml"))) ||
    (await pathExists(join(root, "phpunit.xml.dist")))
  ) {
    return "vendor/bin/phpunit";
  }
  return null;
}

async function phpTestFiles(root: string): Promise<string[]> {
  return (await walk(root, ["tests"])).filter((path) => path.endsWith("Test.php")).slice(0, 300);
}

function testSuiteSeeds(
  testFiles: string[],
  command: string | null,
  projectType: "Laravel" | "PHP",
): FeatureSeed[] {
  return [...groupedTestFiles(testFiles).entries()].flatMap(([root, files]) =>
    partitionSourceFiles(root, files, groupedMaxOwnedFiles).map((group) => ({
      title: `${projectType} test suite ${group.label}`,
      summary: `${projectType} tests in ${group.label}.`,
      kind: "test-suite",
      source: projectType === "Laravel" ? "laravel-test-suite" : "php-test-suite",
      confidence: "medium",
      entryPath: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: "PHP test" })),
      contextFiles: [],
      tests: group.files.map((path) => ({ path, command })),
      tags: projectType === "Laravel" ? ["php", "laravel", "test"] : ["php", "test"],
      trustBoundaries: [],
      testCommand: command,
      skipNearbyTests: true,
    })),
  );
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
  const parts = path.split("/");
  if (parts[0] === "tests") {
    if (parts.length === 2) {
      return "tests";
    }
    return `${parts[0]}/${parts[1]}`;
  }
  return dirname(path);
}

function associatedPhpTests(
  files: string[],
  tests: string[],
  command: string | null,
): SeedTestRef[] {
  const stems = new Set(files.map((file) => basename(file, ".php")));
  const directories = new Set(files.map((file) => dirname(file)));
  return tests
    .filter((test) => {
      const testStem = basename(test, ".php").replace(/Test$/u, "");
      return (
        stems.has(testStem) ||
        [...stems].some((stem) => testStem.includes(stem)) ||
        [...directories].some((dir) => pathMatchesPrefix(test, dir))
      );
    })
    .slice(0, maxAssociatedTests)
    .map((path) => ({ path, command }));
}

async function phpFilesUnder(root: string, prefix: string): Promise<string[]> {
  if (!(await isSafeDirectory(root, join(root, prefix)))) {
    return [];
  }
  return (await walk(root, [prefix]))
    .filter((path) => path.endsWith(".php"))
    .filter((path) => !laravelShouldSkip(path));
}

function laravelShouldSkip(path: string): boolean {
  return shouldSkip(path) || /(^|\/)(vendor|storage|bootstrap\/cache)(\/|$)/u.test(path);
}

function partitionSourceFiles(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
): SourceGroup[] {
  const sorted = files.toSorted();
  const groups: SourceGroup[] = [];
  for (let index = 0; index < sorted.length; index += maxFiles) {
    const chunk = sorted.slice(index, index + maxFiles);
    const part = Math.floor(index / maxFiles) + 1;
    groups.push({
      label: sorted.length <= maxFiles ? sourceRoot : `${sourceRoot}#${part}`,
      files: chunk,
    });
  }
  return groups;
}

async function existingRefs(root: string, refs: Array<[string, string]>): Promise<SeedFileRef[]> {
  const output: SeedFileRef[] = [];
  for (const [path, reason] of refs) {
    if (await pathExists(join(root, path))) {
      output.push({ path, reason });
    }
  }
  return output;
}

function uniqueRefs(refs: SeedFileRef[]): SeedFileRef[] {
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

function trustBoundariesForName(name: string): TrustBoundary[] {
  const boundaries = new Set<TrustBoundary>(["database", "serialization"]);
  if (/audio|http|api|telegram|vector|embedding|client|s3|storage/iu.test(name)) {
    boundaries.add("network");
    boundaries.add("external-api");
  }
  if (/upload|file|disk|asset|report|artifact|catalog/iu.test(name)) {
    boundaries.add("filesystem");
  }
  if (/queue|job|batch|async|process/iu.test(name)) {
    boundaries.add("concurrency");
  }
  return [...boundaries];
}
