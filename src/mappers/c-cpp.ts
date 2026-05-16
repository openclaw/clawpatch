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
  const files = (await walk(root, [""])).filter(
    (path) =>
      !isCOrCppDependencyPath(path) &&
      !isSampleProjectPath(path) &&
      (isCOrCppSource(path) || isMakefile(path) || isCMake(path)),
  );
  if (files.length === 0) {
    return [];
  }
  const seeds: FeatureSeed[] = [];
  seeds.push(...(await autotoolsTargets(root, files)));
  seeds.push(...(await cmakeTargets(root, files)));
  const alreadySeeded = new Set(
    seeds
      .filter((seed) => seed.kind === "cli-command")
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
  const makefiles = files.filter((file) => file.endsWith("Makefile.am"));
  for (const makefile of makefiles) {
    const body = collapseBackslashContinuations(
      stripLineComments(await readFile(join(root, makefile), "utf8").catch(() => ""), "#"),
    );
    const dir = parentDir(makefile);
    for (const target of readVariableWords(body, "bin_PROGRAMS")) {
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
  const cmakeFiles = files.filter(isCMake);
  const sourceDirs = await cmakeSourceDirs(root, cmakeFiles);
  const extraSources = await cmakeTargetSources(root, cmakeFiles, sourceDirs);
  const exePattern = /add_executable\s*\(\s*([A-Za-z0-9_.+-]+)(?:\s+([^)]*))?\)/gimsu;
  const libPattern = /add_library\s*\(\s*([A-Za-z0-9_.+-]+)(?:\s+([^)]*))?\)/gimsu;
  for (const cmakeFile of cmakeFiles) {
    const body = stripCMakeComments(await readFile(join(root, cmakeFile), "utf8").catch(() => ""));
    const dir = sourceDirs.get(cmakeFile) ?? parentDir(cmakeFile);
    for (const match of body.matchAll(exePattern)) {
      const target = match[1] ?? "";
      if (!isValidTargetName(target)) {
        continue;
      }
      const sourcePaths = uniqueStrings([
        ...(await targetSourcePaths(root, dir, splitWords(match[2] ?? ""))),
        ...(extraSources.get(target) ?? []),
      ]);
      if (sourcePaths.length === 0) {
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
        ...(extraSources.get(target) ?? []),
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

async function cmakeTargetSources(
  root: string,
  cmakeFiles: string[],
  sourceDirs: Map<string, string>,
): Promise<Map<string, string[]>> {
  const sources = new Map<string, string[]>();
  const pattern = /target_sources\s*\(\s*([A-Za-z0-9_.+-]+)\s+([^)]*)\)/gimsu;
  for (const cmakeFile of cmakeFiles) {
    const body = stripCMakeComments(await readFile(join(root, cmakeFile), "utf8").catch(() => ""));
    const dir = sourceDirs.get(cmakeFile) ?? parentDir(cmakeFile);
    for (const match of body.matchAll(pattern)) {
      const target = match[1] ?? "";
      if (!isValidTargetName(target)) {
        continue;
      }
      const existing = sources.get(target) ?? [];
      sources.set(
        target,
        uniqueStrings([
          ...existing,
          ...(await targetSourcePaths(root, dir, splitWords(match[2] ?? ""))),
        ]),
      );
    }
  }
  return sources;
}

async function cmakeSourceDirs(root: string, cmakeFiles: string[]): Promise<Map<string, string>> {
  const dirs = new Map<string, string>();
  const cmakeFileSet = new Set(cmakeFiles);
  for (const cmakeFile of cmakeFiles.filter((file) => file.endsWith("CMakeLists.txt"))) {
    const dir = parentDir(cmakeFile);
    dirs.set(cmakeFile, dir);
    const body = stripCMakeComments(await readFile(join(root, cmakeFile), "utf8").catch(() => ""));
    for (const include of cmakeIncludes(body)) {
      const includePath = include.endsWith(".cmake") ? include : `${include}.cmake`;
      const full = isAbsolute(includePath) ? includePath : join(root, prefixDir(dir, includePath));
      const rel = normalize(relative(root, full));
      if (cmakeFileSet.has(rel)) {
        dirs.set(rel, dir);
      }
    }
  }
  return dirs;
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
  const stripped = stripBlockComments(stripLineComments(source, "//"));
  return /(?:^|[;{}\n])\s*(?:extern\s+"C"\s*)?(?:[\w:<>~*&\s]+\s+)+main\s*\([^;{}]*\)\s*(?:noexcept\s*)?(?:->\s*[\w:<>~*&\s]+)?\s*\{/u.test(
    stripped,
  );
}

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ");
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
  const pattern = new RegExp(`^\\s*${escaped}\\s*(?:\\+?=)\\s*(.+)$`, "gmu");
  for (const match of body.matchAll(pattern)) {
    words.push(...splitWords(match[1] ?? ""));
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
    .map(unquoteWord);
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
  return /(^|\/)vendor(\/|$)/u.test(path);
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
    const key = `${seed.entryPath}:${seed.kind}:${seed.command ?? seed.symbol ?? seed.title}`;
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
