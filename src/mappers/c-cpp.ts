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
import { FeatureSeed, SeedFileRef } from "./types.js";

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
      const sourcePaths = await targetSourcePaths(root, dir, expandAutomakeSources(root, sources));
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
      const sourcePaths = await targetSourcePaths(root, dir, expandAutomakeSources(root, sources));
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
  const extraSourceSets = await cmakeTargetSources(root, contexts);
  for (const {
    file: cmakeFile,
    sourceDir: dir,
    targetScope: scope,
    cmakeSourceDir,
    projectSourceDir,
    projectName,
  } of contexts) {
    const listDir = parentDir(cmakeFile);
    const body = stripCMakeComments(await readFile(join(root, cmakeFile), "utf8").catch(() => ""));
    const effectiveProjectSourceDir = cmakeDeclaresProject(body) ? dir : projectSourceDir;
    const effectiveProjectName = cmakeProjectName(body) ?? projectName;
    for (const args of cmakeCommandArgs(body, "add_executable")) {
      const [rawTarget = "", ...sources] = splitWords(args);
      const target = resolveCMakeTargetName(rawTarget, effectiveProjectName);
      if (!isValidTargetName(target)) {
        continue;
      }
      const extraSources = extraSourceSets.get(cmakeTargetKey(scope, target));
      const sourcePaths = uniqueStrings([
        ...(await targetSourcePaths(
          root,
          dir,
          sources,
          listDir,
          cmakeSourceDir,
          effectiveProjectSourceDir,
        )),
        ...(extraSources?.paths ?? []),
      ]);
      if (sourcePaths.length === 0) {
        continue;
      }
      const contextFiles = cmakeTargetContextFiles(
        cmakeFile,
        "CMake target declaration",
        extraSources,
      );
      const entryPath = await pickExecutableEntry(root, sourcePaths, target);
      if (entryPath === null) {
        continue;
      }
      const testEntryPath = cmakeTestExecutableEntry(target, entryPath);
      if (testEntryPath !== null) {
        seeds.push({
          title: `CMake test suite ${target}`,
          summary: `CMake test executable ${target} declared in ${cmakeFile}.`,
          kind: "test-suite",
          source: "cmake-test",
          confidence: "high",
          entryPath: testEntryPath,
          symbol: null,
          route: null,
          command: null,
          tags: [languageTag(testEntryPath), "test"],
          trustBoundaries: [],
          ownedFiles: targetSourceRefs(sourcePaths),
          contextFiles: cmakeTargetContextFiles(
            cmakeFile,
            "CMake test target declaration",
            extraSources,
          ),
          tests: sourcePaths.filter(isCOrCppTestPath).map((path) => ({ path, command: null })),
          skipNearbyTests: true,
        });
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
        contextFiles,
      });
    }
    for (const args of cmakeCommandArgs(body, "add_library")) {
      const [rawTarget = "", ...sources] = splitWords(args);
      const target = resolveCMakeTargetName(rawTarget, effectiveProjectName);
      if (!isValidTargetName(target)) {
        continue;
      }
      const extraSources = extraSourceSets.get(cmakeTargetKey(scope, target));
      const sourcePaths = uniqueStrings([
        ...(await targetSourcePaths(
          root,
          dir,
          sources,
          listDir,
          cmakeSourceDir,
          effectiveProjectSourceDir,
        )),
        ...(extraSources?.paths ?? []),
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
        contextFiles: cmakeTargetContextFiles(cmakeFile, "CMake target declaration", extraSources),
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
  cmakeSourceDir: string;
  projectSourceDir: string;
  projectName: string;
};

type CMakeTargetSources = {
  paths: string[];
  contextFiles: SeedFileRef[];
};

async function referencedCMakeFiles(root: string, files: string[]): Promise<CMakeDiscovery> {
  const cmakeFileSet = new Set(files.filter(isCMake));
  const contexts = new Map<string, CMakeContext>();
  const pending: CMakeContext[] = [];
  for (const cmakeList of files.filter((file) => file.endsWith("CMakeLists.txt"))) {
    const dir = parentDir(cmakeList);
    queueCMakeFile(
      {
        file: cmakeList,
        sourceDir: dir,
        targetScope: dir,
        cmakeSourceDir: dir,
        projectSourceDir: dir,
        projectName: "",
      },
      contexts,
      pending,
    );
  }
  while (pending.length > 0) {
    const context = pending.shift();
    if (context === undefined) {
      continue;
    }
    const {
      file: cmakeFile,
      sourceDir: dir,
      targetScope: scope,
      cmakeSourceDir,
      projectSourceDir,
      projectName,
    } = context;
    const listDir = parentDir(cmakeFile);
    const body = stripCMakeComments(await readFile(join(root, cmakeFile), "utf8").catch(() => ""));
    const effectiveProjectSourceDir = cmakeDeclaresProject(body) ? dir : projectSourceDir;
    const effectiveProjectName = cmakeProjectName(body) ?? projectName;
    for (const include of cmakeIncludes(body)) {
      const includePath = include.endsWith(".cmake") ? include : `${include}.cmake`;
      const full = resolveCMakePath(
        root,
        dir,
        listDir,
        cmakeSourceDir,
        effectiveProjectSourceDir,
        includePath,
      );
      if (full === null) {
        continue;
      }
      const rel = normalize(relative(root, full));
      if (!cmakeFileSet.has(rel)) {
        continue;
      }
      queueCMakeFile(
        {
          file: rel,
          sourceDir: dir,
          targetScope: scope,
          cmakeSourceDir,
          projectSourceDir: effectiveProjectSourceDir,
          projectName: effectiveProjectName,
        },
        contexts,
        pending,
      );
    }
    for (const child of cmakeSubdirectories(body)) {
      const childFull = resolveCMakePath(
        root,
        dir,
        listDir,
        cmakeSourceDir,
        effectiveProjectSourceDir,
        child,
      );
      if (childFull === null) {
        continue;
      }
      const full = join(childFull, "CMakeLists.txt");
      const rel = normalize(relative(root, full));
      if (!cmakeFileSet.has(rel)) {
        continue;
      }
      queueCMakeFile(
        {
          file: rel,
          sourceDir: parentDir(rel),
          targetScope: scope,
          cmakeSourceDir,
          projectSourceDir: effectiveProjectSourceDir,
          projectName: effectiveProjectName,
        },
        contexts,
        pending,
      );
    }
  }
  const discoveredContexts = preferredCMakeContexts([...contexts.values()]);
  return {
    contexts: discoveredContexts.toSorted((left, right) =>
      cmakeContextKey(left).localeCompare(cmakeContextKey(right)),
    ),
  };
}

function preferredCMakeContexts(contexts: CMakeContext[]): CMakeContext[] {
  const byFile = new Map<string, CMakeContext[]>();
  for (const context of contexts) {
    byFile.set(context.file, [...(byFile.get(context.file) ?? []), context]);
  }
  return contexts.filter((context) => {
    const fileContexts = byFile.get(context.file) ?? [];
    if (fileContexts.length < 2 || context.cmakeSourceDir !== context.sourceDir) {
      return true;
    }
    return !fileContexts.some((other) => other.cmakeSourceDir !== context.cmakeSourceDir);
  });
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
  return [
    context.file,
    context.sourceDir,
    context.targetScope,
    context.cmakeSourceDir,
    context.projectSourceDir,
    context.projectName,
  ].join("\0");
}

async function cmakeTargetSources(
  root: string,
  contexts: CMakeContext[],
): Promise<Map<string, CMakeTargetSources>> {
  const sources = new Map<string, CMakeTargetSources>();
  for (const {
    file: cmakeFile,
    sourceDir: dir,
    targetScope: scope,
    cmakeSourceDir,
    projectSourceDir,
    projectName,
  } of contexts) {
    const listDir = parentDir(cmakeFile);
    const body = stripCMakeComments(await readFile(join(root, cmakeFile), "utf8").catch(() => ""));
    const effectiveProjectSourceDir = cmakeDeclaresProject(body) ? dir : projectSourceDir;
    const effectiveProjectName = cmakeProjectName(body) ?? projectName;
    for (const args of cmakeCommandArgs(body, "target_sources")) {
      const [rawTarget = "", ...sourceTokens] = splitWords(args);
      const target = resolveCMakeTargetName(rawTarget, effectiveProjectName);
      if (!isValidTargetName(target)) {
        continue;
      }
      const key = cmakeTargetKey(scope, target);
      const existing = sources.get(key);
      const paths = await targetSourcePaths(
        root,
        dir,
        sourceTokens,
        listDir,
        cmakeSourceDir,
        effectiveProjectSourceDir,
      );
      sources.set(key, {
        paths: uniqueStrings([...(existing?.paths ?? []), ...paths]),
        contextFiles: uniqueFileRefs([
          ...(existing?.contextFiles ?? []),
          { path: cmakeFile, reason: "CMake target source declaration" },
        ]),
      });
    }
  }
  return sources;
}

function cmakeDeclaresProject(body: string): boolean {
  return cmakeCommandArgs(body, "project").length > 0;
}

function cmakeProjectName(body: string): string | null {
  for (const args of cmakeCommandArgs(body, "project")) {
    const [name = ""] = splitWords(args);
    if (isValidTargetName(name)) {
      return name;
    }
  }
  return null;
}

function cmakeTargetKey(dir: string, target: string): string {
  return `${dir}\0${target}`;
}

function resolveCMakeTargetName(target: string, projectName: string): string {
  return projectName.length > 0 ? target.replace(/\$\{PROJECT_NAME\}/gu, projectName) : target;
}

function cmakeTargetContextFiles(
  cmakeFile: string,
  reason: string,
  extraSources: CMakeTargetSources | undefined,
): SeedFileRef[] {
  return uniqueFileRefs([{ path: cmakeFile, reason }, ...(extraSources?.contextFiles ?? [])]);
}

function cmakeTestExecutableEntry(target: string, entryPath: string): string | null {
  return /(?:^|[_-])tests?$/iu.test(target) || isCOrCppTestPath(entryPath) ? entryPath : null;
}

function cmakeIncludes(body: string): string[] {
  const includes: string[] = [];
  for (const args of cmakeCommandArgs(body, "include")) {
    const path = splitWords(args)[0];
    if (path !== undefined) {
      includes.push(path);
    }
  }
  return includes;
}

function cmakeSubdirectories(body: string): string[] {
  const directories: string[] = [];
  for (const args of cmakeCommandArgs(body, "add_subdirectory")) {
    const path = splitWords(args)[0];
    if (path !== undefined) {
      directories.push(path);
    }
  }
  return directories;
}

function cmakeCommandArgs(body: string, command: string): string[] {
  const args: string[] = [];
  const needle = command.toLowerCase();
  let depth = 0;
  let blockDepth = 0;
  for (let index = 0; index < body.length; ) {
    const skipped = cmakeQuotedOrBracketEnd(body, index);
    if (skipped !== null) {
      index = skipped;
      continue;
    }
    const parsed = depth === 0 ? cmakeCommandAt(body, index) : null;
    if (parsed !== null) {
      if (blockDepth > 0) {
        if (parsed.name === "function" || parsed.name === "macro") {
          blockDepth += 1;
        } else if (parsed.name === "endfunction" || parsed.name === "endmacro") {
          blockDepth = Math.max(0, blockDepth - 1);
        }
        index = parsed.close + 1;
        continue;
      }
      if (parsed.name === "function" || parsed.name === "macro") {
        blockDepth = 1;
        index = parsed.close + 1;
        continue;
      }
      if (parsed.name === needle) {
        args.push(body.slice(parsed.open + 1, parsed.close));
        index = parsed.close + 1;
        continue;
      }
      index = parsed.close + 1;
      continue;
    }
    if (body[index] === "(") {
      depth += 1;
    } else if (body[index] === ")") {
      depth = Math.max(0, depth - 1);
    }
    index += 1;
  }
  return args;
}

type CMakeCommandCall = {
  name: string;
  open: number;
  close: number;
};

function cmakeCommandAt(body: string, index: number): CMakeCommandCall | null {
  if (isIdentifierChar(body[index - 1] ?? "")) {
    return null;
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(body.slice(index));
  if (match === null) {
    return null;
  }
  const name = match[0].toLowerCase();
  let open = index + match[0].length;
  while (/\s/u.test(body[open] ?? "")) {
    open += 1;
  }
  if (body[open] !== "(") {
    return null;
  }
  const close = cmakeCommandClose(body, open);
  return close === null ? null : { name, open, close };
}

function cmakeCommandClose(body: string, open: number): number | null {
  let depth = 1;
  for (let index = open + 1; index < body.length; ) {
    const skipped = cmakeQuotedOrBracketEnd(body, index);
    if (skipped !== null) {
      index = skipped;
      continue;
    }
    if (body[index] === "(") {
      depth += 1;
    } else if (body[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  return null;
}

function cmakeQuotedOrBracketEnd(body: string, index: number): number | null {
  if (body[index] === '"') {
    return cmakeQuotedEnd(body, index);
  }
  return cmakeBracketEnd(body, index);
}

function cmakeQuotedEnd(body: string, index: number): number {
  for (let cursor = index + 1; cursor < body.length; cursor += 1) {
    if (body[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (body[cursor] === '"') {
      return cursor + 1;
    }
  }
  return body.length;
}

function cmakeBracketEnd(body: string, index: number): number | null {
  const match = /^\[(=*)\[/u.exec(body.slice(index));
  if (match === null) {
    return null;
  }
  const delimiter = match[1] ?? "";
  const terminator = `]${delimiter}]`;
  const contentStart = index + match[0].length;
  const end = body.indexOf(terminator, contentStart);
  return end === -1 ? body.length : end + terminator.length;
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
  let output = "";
  for (let index = 0; index < source.length; ) {
    if (source[index] === '"') {
      const end = cmakeQuotedEnd(source, index);
      output += source.slice(index, end);
      index = end;
      continue;
    }
    const bracketEnd = cmakeBracketEnd(source, index);
    if (bracketEnd !== null) {
      output += source.slice(index, bracketEnd);
      index = bracketEnd;
      continue;
    }
    const bracketComment = /^#\[(=*)\[/u.exec(source.slice(index));
    if (bracketComment !== null) {
      const terminator = `]${bracketComment[1] ?? ""}]`;
      const start = index;
      const end = source.indexOf(terminator, index + bracketComment[0].length);
      index = end === -1 ? source.length : end + terminator.length;
      output += blankComment(source.slice(start, index));
      continue;
    }
    if (source[index] === "#") {
      const end = source.indexOf("\n", index + 1);
      const comment = source.slice(index, end === -1 ? source.length : end);
      output += blankComment(comment);
      index = end === -1 ? source.length : end;
      continue;
    }
    output += source[index];
    index += 1;
  }
  return output;
}

function blankComment(source: string): string {
  return source.replace(/[^\n]/gu, " ");
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

type CMakeWord = {
  value: string;
  quoted: boolean;
};

function splitWords(value: string): string[] {
  return cmakeWords(value)
    .flatMap((word) => (word.quoted ? [word.value] : splitCMakeUnquotedWord(word.value)))
    .filter((word) => word.length > 0);
}

function cmakeWords(value: string): CMakeWord[] {
  const words: CMakeWord[] = [];
  for (let index = 0; index < value.length; ) {
    while (/\s/u.test(value[index] ?? "")) {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }
    if (value[index] === '"') {
      const end = cmakeQuotedEnd(value, index);
      words.push({ value: unescapeCMakeQuoted(value.slice(index + 1, end - 1)), quoted: true });
      index = end;
      continue;
    }
    const bracketEnd = cmakeBracketEnd(value, index);
    if (bracketEnd !== null) {
      const opener = /^\[(=*)\[/u.exec(value.slice(index))?.[0] ?? "[[";
      const terminatorLength = opener.length;
      words.push({
        value: value.slice(index + opener.length, bracketEnd - terminatorLength),
        quoted: true,
      });
      index = bracketEnd;
      continue;
    }
    const start = index;
    while (index < value.length) {
      if (value[index] === "\\" && index + 1 < value.length) {
        index += 2;
        continue;
      }
      if (/\s/u.test(value[index] ?? "")) {
        break;
      }
      index += 1;
    }
    words.push({ value: value.slice(start, index), quoted: false });
  }
  return words;
}

function splitCMakeUnquotedWord(value: string): string[] {
  const words = [""];
  for (let index = 0; index < value.length; ) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      words[words.length - 1] += value[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === ";") {
      words.push("");
      index += 1;
      continue;
    }
    words[words.length - 1] += char ?? "";
    index += 1;
  }
  return words;
}

function unescapeCMakeQuoted(value: string): string {
  return value.replace(/\\(.)/gsu, "$1");
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
    const base = candidate.split("/").at(-1) ?? candidate;
    const stem = base.replace(/\.[^.]+$/u, "");
    if (stem === targetName) {
      return candidate;
    }
  }
  const preferred = candidatesToPick.find((candidate) => {
    const base = candidate.split("/").at(-1) ?? candidate;
    const stem = base.replace(/\.[^.]+$/u, "");
    return stem.startsWith(targetName) || base.startsWith("main.");
  });
  if (preferred !== undefined) {
    return preferred;
  }
  const first = candidatesToPick[0];
  return first === undefined ? null : first;
}

async function targetSourcePaths(
  root: string,
  dir: string,
  sources: string[],
  listDir = dir,
  cmakeSourceDir = dir,
  projectSourceDir = dir,
): Promise<string[]> {
  const paths: string[] = [];
  for (const source of sources.filter(isCOrCppSource)) {
    const full = resolveCMakePath(root, dir, listDir, cmakeSourceDir, projectSourceDir, source);
    if (full === null) {
      continue;
    }
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

function resolveCMakePath(
  root: string,
  sourceDir: string,
  listDir: string,
  cmakeSourceDir: string,
  projectSourceDir: string,
  value: string,
): string | null {
  const expanded = expandCMakeDirVariables(
    root,
    sourceDir,
    listDir,
    cmakeSourceDir,
    projectSourceDir,
    value,
  );
  if (expanded.includes("$")) {
    return null;
  }
  return isAbsolute(expanded) ? expanded : join(root, prefixDir(sourceDir, expanded));
}

function expandCMakeDirVariables(
  root: string,
  sourceDir: string,
  listDir: string,
  cmakeSourceDir: string,
  projectSourceDir: string,
  value: string,
): string {
  const sourceRoot = join(root, sourceDir);
  const listRoot = join(root, listDir);
  const cmakeRoot = join(root, cmakeSourceDir);
  const projectRoot = join(root, projectSourceDir);
  return value
    .replace(/\$\{CMAKE_CURRENT_SOURCE_DIR\}/gu, sourceRoot)
    .replace(/\$\{CMAKE_CURRENT_LIST_DIR\}/gu, listRoot)
    .replace(/\$\{CMAKE_SOURCE_DIR\}/gu, cmakeRoot)
    .replace(/\$\{PROJECT_SOURCE_DIR\}/gu, projectRoot);
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

function uniqueFileRefs(values: SeedFileRef[]): SeedFileRef[] {
  const seen = new Set<string>();
  const output: SeedFileRef[] = [];
  for (const value of values) {
    if (seen.has(value.path)) {
      continue;
    }
    seen.add(value.path);
    output.push(value);
  }
  return output;
}

function automakeVariableName(target: string): string {
  return target.replace(/[^A-Za-z0-9@]/gu, "_");
}

function normalizeAutomakeProgramTarget(target: string): string {
  return target.replace(/\$[({]EXEEXT[)}]|@EXEEXT@/gu, "");
}

function expandAutomakeSources(root: string, sources: string[]): string[] {
  return sources.map((source) => expandAutomakeSource(root, source));
}

function expandAutomakeSource(root: string, source: string): string {
  const normalized = normalize(source);
  const srcdir = /^(?:\$\((?:srcdir)\)|\$\{srcdir\}|@srcdir@)(?:\/(.*)|$)/u.exec(normalized);
  if (srcdir !== null) {
    return srcdir[1] ?? "";
  }
  const topSrcdir = /^(?:\$\((?:top_srcdir)\)|\$\{top_srcdir\}|@top_srcdir@)(?:\/(.*)|$)/u.exec(
    normalized,
  );
  return topSrcdir === null ? source : join(root, topSrcdir[1] ?? "");
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
