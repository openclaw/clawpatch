import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  isSafeFile,
  isCOrCppTestPath,
  isSampleProjectPath,
  normalize,
  packageTrustBoundaries,
  shouldSkip,
  stripLineComments,
  walk,
} from "./shared.js";
import { FeatureSeed } from "./types.js";

export async function cCppSeeds(root: string): Promise<FeatureSeed[]> {
  const files = (await walk(root, [""], shouldSkipCOrCppPath)).filter(
    (path) =>
      !isSampleProjectPath(path) && (isCOrCppSource(path) || isMakefile(path) || isCMake(path)),
  );
  if (files.length === 0) {
    return [];
  }
  const seeds: FeatureSeed[] = [];
  seeds.push(...(await autotoolsTargets(root, files)));
  seeds.push(...(await cmakeTargets(root, files)));
  const alreadySeeded = new Set(
    seeds
      .filter((seed) => seed.kind === "cli-command" || seed.source === "cmake-test")
      .flatMap((seed) => [seed.entryPath, ...(seed.ownedFiles?.map((file) => file.path) ?? [])]),
  );
  seeds.push(...(await mainFunctionTargets(root, files, alreadySeeded)));
  return dedupeByEntry(seeds);
}

function isCOrCppSource(path: string): boolean {
  return /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/iu.test(path);
}

function isCOrCppCompilable(path: string): boolean {
  return /\.(?:c|cc|cpp|cxx)$/iu.test(path);
}

function isMakefile(path: string): boolean {
  return path.endsWith("Makefile.am") || path.endsWith("Makefile.in");
}

function isCMake(path: string): boolean {
  return path.endsWith("CMakeLists.txt") || path.endsWith(".cmake");
}

function languageTag(path: string): "c" | "cpp" {
  return /\.(?:C|H)$/u.test(path) || /\.(?:cc|cpp|cxx|hh|hpp|hxx)$/iu.test(path) ? "cpp" : "c";
}

async function autotoolsTargets(root: string, files: string[]): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  const makefiles = files.filter(isMakefile);
  for (const makefile of makefiles) {
    const body = collapseBackslashContinuations(
      stripLineComments(await readFile(join(root, makefile), "utf8").catch(() => ""), "#"),
    );
    const dir = parentDir(makefile);
    for (const rawTarget of readVariableWords(body, "bin_PROGRAMS")) {
      const target = normalizeAutomakeProgramTarget(rawTarget);
      if (!isValidTargetName(target)) {
        continue;
      }
      const sources = await automakeTargetSources(root, dir, body, target);
      const sourcePaths = await targetSourcePaths(root, dir, sources);
      if (sourcePaths.length === 0) {
        continue;
      }
      const entryPath = await pickExecutableEntry(root, sourcePaths, target);
      if (entryPath === null) {
        continue;
      }
      const tag = languageTag(entryPath);
      seeds.push({
        title: `Autotools binary ${target}`,
        summary: `Autotools bin_PROGRAMS target declared in ${makefile}.`,
        kind: "cli-command",
        source: "autotools-bin",
        confidence: "high",
        entryPath,
        symbol: "main",
        route: null,
        command: target,
        tags: [tag, "cli"],
        trustBoundaries: ["user-input", "filesystem", "process-exec"],
        ownedFiles: targetSourceRefs(sourcePaths),
        contextFiles: [{ path: makefile, reason: "build target declaration" }],
      });
    }
    for (const rawTarget of readVariableWords(body, "lib_LTLIBRARIES")) {
      if (!isValidTargetName(rawTarget)) {
        continue;
      }
      const target = rawTarget.replace(/\.la$/u, "");
      const sources = readTargetSources(body, automakeVariableName(rawTarget));
      const sourcePaths = await targetSourcePaths(root, dir, sources);
      if (sourcePaths.length === 0) {
        continue;
      }
      const entryPath = pickEntry(sourcePaths, target) ?? makefile;
      const tag = languageTag(entryPath);
      seeds.push({
        title: `Autotools library ${target}`,
        summary: `Autotools lib_LTLIBRARIES target declared in ${makefile}.`,
        kind: "library",
        source: "autotools-lib",
        confidence: "high",
        entryPath,
        symbol: null,
        route: null,
        command: null,
        tags: [tag, "library"],
        trustBoundaries: packageTrustBoundaries(target),
        ownedFiles: targetSourceRefs(sourcePaths),
        contextFiles: [{ path: makefile, reason: "build target declaration" }],
      });
    }
  }
  return seeds;
}

async function cmakeTargets(root: string, files: string[]): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  const { contexts } = await referencedCMakeFiles(root, files);
  const extraSources = await cmakeTargetSources(root, contexts);
  const exePattern = /add_executable\s*\(\s*([A-Za-z0-9_.+-]+)(?:\s+([^)]*))?\)/gimsu;
  const libPattern = /add_library\s*\(\s*([A-Za-z0-9_.+-]+)(?:\s+([^)]*))?\)/gimsu;
  for (const { file: cmakeFile, sourceDir: dir, targetScope: scope } of contexts) {
    const body = stripCMakeComments(await readFile(join(root, cmakeFile), "utf8").catch(() => ""));
    for (const match of body.matchAll(exePattern)) {
      const target = match[1] ?? "";
      if (!isValidTargetName(target)) {
        continue;
      }
      const sourcePaths = uniqueStrings([
        ...(await targetSourcePaths(root, dir, splitWords(match[2] ?? ""))),
        ...(extraSources.get(cmakeTargetKey(scope, target)) ?? []),
      ]);
      if (sourcePaths.length === 0) {
        continue;
      }
      if (isCMakeTestExecutableTarget(target, sourcePaths)) {
        const entryPath = pickEntry(sourcePaths, target) ?? sourcePaths[0];
        if (entryPath === undefined) {
          continue;
        }
        seeds.push({
          title: `CMake test suite ${target}`,
          summary: `CMake test executable ${target} declared in ${cmakeFile}.`,
          kind: "test-suite",
          source: "cmake-test",
          confidence: "high",
          entryPath,
          symbol: null,
          route: null,
          command: null,
          tags: [languageTag(entryPath), "test"],
          trustBoundaries: [],
          ownedFiles: targetSourceRefs(sourcePaths),
          contextFiles: [{ path: cmakeFile, reason: "CMake test target declaration" }],
          tests: sourcePaths.filter(isCOrCppTestPath).map((path) => ({ path, command: null })),
          skipNearbyTests: true,
        });
        continue;
      }
      const entryPath = await pickExecutableEntry(root, sourcePaths, target);
      if (entryPath === null) {
        continue;
      }
      const tag = languageTag(entryPath);
      seeds.push({
        title: `CMake binary ${target}`,
        summary: `CMake add_executable(${target}) declared in ${cmakeFile}.`,
        kind: "cli-command",
        source: "cmake-bin",
        confidence: "high",
        entryPath,
        symbol: "main",
        route: null,
        command: target,
        tags: [tag, "cli"],
        trustBoundaries: ["user-input", "filesystem", "process-exec"],
        ownedFiles: targetSourceRefs(sourcePaths),
        contextFiles: [{ path: cmakeFile, reason: "CMake target declaration" }],
      });
    }
    for (const match of body.matchAll(libPattern)) {
      const target = match[1] ?? "";
      if (!isValidTargetName(target)) {
        continue;
      }
      const sourcePaths = uniqueStrings([
        ...(await targetSourcePaths(root, dir, splitWords(match[2] ?? ""))),
        ...(extraSources.get(cmakeTargetKey(scope, target)) ?? []),
      ]);
      if (sourcePaths.length === 0) {
        continue;
      }
      const entryPath = pickEntry(sourcePaths, target) ?? cmakeFile;
      const tag = languageTag(entryPath);
      seeds.push({
        title: `CMake library ${target}`,
        summary: `CMake add_library(${target}) declared in ${cmakeFile}.`,
        kind: "library",
        source: "cmake-lib",
        confidence: "high",
        entryPath,
        symbol: null,
        route: null,
        command: null,
        tags: [tag, "library"],
        trustBoundaries: packageTrustBoundaries(target),
        ownedFiles: targetSourceRefs(sourcePaths),
        contextFiles: [{ path: cmakeFile, reason: "CMake target declaration" }],
      });
    }
  }
  return seeds;
}

type CMakeDiscovery = {
  contexts: CMakeContext[];
};

type CMakeContext = {
  file: string;
  sourceDir: string;
  targetScope: string;
};

async function referencedCMakeFiles(root: string, files: string[]): Promise<CMakeDiscovery> {
  const cmakeFileSet = new Set(files.filter(isCMake));
  const contexts = new Map<string, CMakeContext>();
  const pending: CMakeContext[] = [];
  for (const cmakeList of files.filter((file) => file.endsWith("CMakeLists.txt"))) {
    const dir = parentDir(cmakeList);
    queueCMakeFile({ file: cmakeList, sourceDir: dir, targetScope: dir }, contexts, pending);
  }
  while (pending.length > 0) {
    const context = pending.shift();
    if (context === undefined) {
      continue;
    }
    const { file: cmakeFile, sourceDir: dir, targetScope: scope } = context;
    const body = stripCMakeComments(await readFile(join(root, cmakeFile), "utf8").catch(() => ""));
    for (const include of cmakeIncludes(body)) {
      const includePath = include.endsWith(".cmake") ? include : `${include}.cmake`;
      const full = isAbsolute(includePath) ? includePath : join(root, prefixDir(dir, includePath));
      const rel = normalize(relative(root, full));
      if (!cmakeFileSet.has(rel)) {
        continue;
      }
      queueCMakeFile({ file: rel, sourceDir: dir, targetScope: scope }, contexts, pending);
    }
    for (const child of cmakeSubdirectories(body)) {
      const full = isAbsolute(child) ? child : join(root, prefixDir(dir, child), "CMakeLists.txt");
      const rel = normalize(relative(root, full));
      if (!cmakeFileSet.has(rel)) {
        continue;
      }
      queueCMakeFile(
        { file: rel, sourceDir: parentDir(rel), targetScope: scope },
        contexts,
        pending,
      );
    }
  }
  return {
    contexts: [...contexts.values()].toSorted((left, right) =>
      cmakeContextKey(left).localeCompare(cmakeContextKey(right)),
    ),
  };
}

function queueCMakeFile(
  context: CMakeContext,
  contexts: Map<string, CMakeContext>,
  pending: CMakeContext[],
): void {
  const key = cmakeContextKey(context);
  if (!contexts.has(key)) {
    contexts.set(key, context);
    pending.push(context);
  }
}

function cmakeContextKey(context: CMakeContext): string {
  return `${context.file}\0${context.sourceDir}\0${context.targetScope}`;
}

async function cmakeTargetSources(
  root: string,
  contexts: CMakeContext[],
): Promise<Map<string, string[]>> {
  const sources = new Map<string, string[]>();
  const pattern = /target_sources\s*\(\s*([A-Za-z0-9_.+-]+)\s+([^)]*)\)/gimsu;
  for (const { file: cmakeFile, sourceDir: dir, targetScope: scope } of contexts) {
    const body = stripCMakeComments(await readFile(join(root, cmakeFile), "utf8").catch(() => ""));
    for (const match of body.matchAll(pattern)) {
      const target = match[1] ?? "";
      if (!isValidTargetName(target)) {
        continue;
      }
      const key = cmakeTargetKey(scope, target);
      const existing = sources.get(key) ?? [];
      sources.set(
        key,
        uniqueStrings([
          ...existing,
          ...(await targetSourcePaths(root, dir, splitWords(match[2] ?? ""))),
        ]),
      );
    }
  }
  return sources;
}

function cmakeTargetKey(dir: string, target: string): string {
  return `${dir}\0${target}`;
}

function isCMakeTestExecutableTarget(target: string, sourcePaths: string[]): boolean {
  return /(?:^|[_-])tests?$/iu.test(target) || sourcePaths.some(isCOrCppTestPath);
}

function cmakeIncludes(body: string): string[] {
  const includes: string[] = [];
  for (const match of body.matchAll(/include\s*\(([^)]*)\)/gimsu)) {
    const path = splitWords(match[1] ?? "")[0];
    if (path !== undefined && !path.startsWith("$")) {
      includes.push(path);
    }
  }
  return includes;
}

function cmakeSubdirectories(body: string): string[] {
  const directories: string[] = [];
  for (const match of body.matchAll(/add_subdirectory\s*\(([^)]*)\)/gimsu)) {
    const path = splitWords(match[1] ?? "")[0];
    if (path !== undefined && !path.startsWith("$")) {
      directories.push(path);
    }
  }
  return directories;
}

async function mainFunctionTargets(
  root: string,
  files: string[],
  alreadySeeded: Set<string>,
): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  for (const file of files.filter(isCOrCppCompilable)) {
    if (alreadySeeded.has(file) || isCOrCppTestPath(file)) {
      continue;
    }
    const source = await readFile(join(root, file), "utf8").catch(() => "");
    if (source.length > 2_000_000 || !definesMain(source)) {
      continue;
    }
    const tag = languageTag(file);
    const command =
      file
        .split("/")
        .at(-1)
        ?.replace(/\.[^.]+$/u, "") ?? "main";
    seeds.push({
      title: `${tag === "cpp" ? "C++" : "C"} binary ${command}`,
      summary: `C/C++ source file with a top-level main() at ${file}.`,
      kind: "cli-command",
      source: "c-main",
      confidence: "medium",
      entryPath: file,
      symbol: "main",
      route: null,
      command,
      tags: [tag, "cli"],
      trustBoundaries: ["user-input", "filesystem", "process-exec"],
    });
  }
  return seeds;
}

function definesMain(source: string): boolean {
  const stripped = stripCOrCppSyntax(source);
  if (!stripped.includes("main")) {
    return false;
  }
  const pattern =
    /(?:^|[;\n])\s*(?:extern\s+"C"\s*)?(?:[\w:<>~*&]+[ \t\r\n]+)+main\s*\([^;{}]*\)\s*(?:noexcept\s*)?(?:->\s*[\w:<>~*&]+(?:[ \t\r\n]+[\w:<>~*&]+)*)?\s*\{/gmu;
  for (const match of stripped.matchAll(pattern)) {
    if (braceDepthBefore(stripped, match.index) === 0) {
      return true;
    }
  }
  return false;
}

function stripCOrCppSyntax(source: string): string {
  let stripped = "";
  for (let index = 0; index < source.length; ) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      stripped += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        stripped += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      stripped += "  ";
      index += 2;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          stripped += "  ";
          index += 2;
          break;
        }
        stripped += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    const raw = rawStringLiteralEnd(source, index);
    if (raw !== null) {
      stripped += blankLiteral(source.slice(index, raw));
      index = raw;
      continue;
    }
    const quote = stringOrCharQuote(source, index);
    if (quote !== null) {
      const start = index;
      index = quote.start + 1;
      while (index < source.length) {
        const literalChar = source[index];
        if (literalChar === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (literalChar === quote.char) {
          break;
        }
      }
      stripped += blankLiteral(source.slice(start, index));
      continue;
    }
    stripped += source[index];
    index += 1;
  }
  return stripped;
}

function rawStringLiteralEnd(source: string, index: number): number | null {
  if (isIdentifierChar(source[index - 1] ?? "")) {
    return null;
  }
  const match = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/u.exec(source.slice(index));
  if (match === null) {
    return null;
  }
  const delimiter = match[1] ?? "";
  const terminator = `)${delimiter}"`;
  const contentStart = index + match[0].length;
  const end = source.indexOf(terminator, contentStart);
  return end === -1 ? source.length : end + terminator.length;
}

type LiteralQuote = {
  char: '"' | "'";
  start: number;
};

function stringOrCharQuote(source: string, index: number): LiteralQuote | null {
  if (isIdentifierChar(source[index - 1] ?? "")) {
    return null;
  }
  const prefixes = ["u8", "u", "U", "L"] as const;
  for (const prefix of prefixes) {
    if (source.startsWith(prefix, index)) {
      const char = source[index + prefix.length];
      if (char === '"' || char === "'") {
        return { char, start: index + prefix.length };
      }
    }
  }
  const char = source[index];
  return char === '"' || char === "'" ? { char, start: index } : null;
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_]/u.test(char);
}

function blankLiteral(literal: string): string {
  return literal.replace(/[^\n]/gu, " ");
}

function braceDepthBefore(source: string, end: number): number {
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

function collapseBackslashContinuations(source: string): string {
  return source.replace(/\\\r?\n/gu, " ");
}

function readTargetSources(body: string, target: string): string[] {
  return readVariableWords(body, `${target}_SOURCES`);
}

function readVariableWords(body: string, variable: string): string[] {
  const words: string[] = [];
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*(\\+?=)\\s*(.*)$`, "gmu");
  for (const match of body.matchAll(pattern)) {
    if (match[1] === "=") {
      words.length = 0;
    }
    words.push(...splitWords(match[2] ?? ""));
  }
  return words;
}

function stripCMakeComments(source: string): string {
  return stripLineComments(source.replace(/#\[(=*)\[[\s\S]*?\]\1\]/gu, " "), "#");
}

async function automakeTargetSources(
  root: string,
  dir: string,
  body: string,
  target: string,
): Promise<string[]> {
  const sources = readTargetSources(body, automakeVariableName(target));
  if (sources.length > 0) {
    return sources;
  }
  return defaultAutomakeSources(root, dir, target);
}

async function defaultAutomakeSources(
  root: string,
  dir: string,
  target: string,
): Promise<string[]> {
  const defaultSources = [`${target}.c`];
  const existing: string[] = [];
  for (const source of defaultSources) {
    if (await isSafeFile(root, join(root, prefixDir(dir, source)))) {
      existing.push(source);
    }
  }
  return existing;
}

function splitWords(value: string): string[] {
  return value
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map(unquoteWord)
    .flatMap((word) => word.split(";"))
    .filter((word) => word.length > 0);
}

function unquoteWord(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.endsWith(quote) ? value.slice(1, -1) : value;
}

async function pickExecutableEntry(
  root: string,
  candidates: string[],
  targetName: string,
): Promise<string | null> {
  const compilableCandidates = candidates.filter(isCOrCppCompilable);
  if (compilableCandidates.length === 0) {
    return null;
  }
  for (const candidate of compilableCandidates) {
    const source = await readFile(join(root, candidate), "utf8").catch(() => "");
    if (source.length <= 2_000_000 && definesMain(source)) {
      return candidate;
    }
  }
  return pickEntry(compilableCandidates, targetName);
}

function pickEntry(candidates: string[], targetName: string): string | null {
  const entryCandidates = candidates.filter(isCOrCppCompilable);
  const candidatesToPick = entryCandidates.length > 0 ? entryCandidates : candidates;
  if (candidatesToPick.length === 0) {
    return null;
  }
  for (const candidate of candidatesToPick) {
    if (candidate.split("/").at(-1) === targetName) {
      return candidate;
    }
  }
  const preferred = candidatesToPick.find((candidate) => {
    const base = candidate.split("/").at(-1) ?? candidate;
    return base.startsWith(targetName) || base.startsWith("main.");
  });
  if (preferred !== undefined) {
    return preferred;
  }
  const first = candidatesToPick[0];
  return first === undefined ? null : first;
}

async function targetSourcePaths(root: string, dir: string, sources: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const source of sources.filter(isCOrCppSource)) {
    const full = isAbsolute(source) ? source : join(root, prefixDir(dir, source));
    const rel = normalize(relative(root, full));
    if (
      !shouldSkip(rel) &&
      !isCOrCppDependencyPath(rel) &&
      !isSampleProjectPath(rel) &&
      (await isSafeFile(root, full))
    ) {
      paths.push(rel);
    }
  }
  return paths;
}

function isCOrCppDependencyPath(path: string): boolean {
  return /(^|\/)(vendor|CMakeFiles|cmake-build-[^/]+)(\/|$)/u.test(path);
}

function shouldSkipCOrCppPath(path: string): boolean {
  return shouldSkip(path) || isCOrCppDependencyPath(path);
}

function targetSourceRefs(sources: string[]): Array<{ path: string; reason: string }> {
  return sources.map((source) => ({ path: source, reason: "target source" }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function automakeVariableName(target: string): string {
  return target.replace(/[^A-Za-z0-9@]/gu, "_");
}

function normalizeAutomakeProgramTarget(target: string): string {
  return target.replace(/\$[({]EXEEXT[)}]|@EXEEXT@/gu, "");
}

function prefixDir(dir: string, file: string): string {
  const normalizedFile = normalize(file).replace(/^\.\//u, "");
  if (dir.length === 0) {
    return normalizedFile;
  }
  return `${dir}${normalizedFile}`;
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index + 1);
}

function isValidTargetName(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("$") &&
    !value.startsWith("\\") &&
    !value.includes("(") &&
    !value.includes("=") &&
    !value.includes("#")
  );
}

function dedupeByEntry(seeds: FeatureSeed[]): FeatureSeed[] {
  const seen = new Set<string>();
  const output: FeatureSeed[] = [];
  for (const seed of seeds) {
    const key = `${seed.source}:${seed.entryPath}:${seed.kind}:${seed.command ?? seed.symbol ?? seed.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(seed);
  }
  return disambiguateFeatureIdCollisions(output);
}

function disambiguateFeatureIdCollisions(seeds: FeatureSeed[]): FeatureSeed[] {
  const counts = new Map<string, number>();
  for (const seed of seeds) {
    const key = featureIdCollisionKey(seed);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return seeds.map((seed) => {
    if ((counts.get(featureIdCollisionKey(seed)) ?? 0) < 2) {
      return seed;
    }
    if (seed.kind !== "library" || seed.symbol !== null) {
      return seed;
    }
    return { ...seed, symbol: disambiguatorFromTitle(seed.title) };
  });
}

function featureIdCollisionKey(seed: FeatureSeed): string {
  return `${seed.kind}:${seed.source}:${seed.entryPath}:${seed.command ?? seed.route ?? seed.symbol ?? ""}`;
}

function disambiguatorFromTitle(title: string): string {
  return title.split(" ").at(-1) ?? title;
}
