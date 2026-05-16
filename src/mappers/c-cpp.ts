import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isSafeFile,
  isCOrCppTestPath,
  normalize,
  packageTrustBoundaries,
  stripLineComments,
  walk,
} from "./shared.js";
import { FeatureSeed } from "./types.js";

export async function cCppSeeds(root: string): Promise<FeatureSeed[]> {
  const files = (await walk(root, [""])).filter(
    (path) => isCOrCppSource(path) || isMakefile(path) || isCMake(path),
  );
  if (files.length === 0) {
    return [];
  }
  const seeds: FeatureSeed[] = [];
  seeds.push(...(await autotoolsTargets(root, files)));
  seeds.push(...(await cmakeTargets(root, files)));
  const alreadySeeded = new Set(
    seeds.filter((seed) => seed.kind === "cli-command").map((seed) => seed.entryPath),
  );
  seeds.push(...(await mainFunctionTargets(root, files, alreadySeeded)));
  return dedupeByEntry(seeds);
}

function isCOrCppSource(path: string): boolean {
  return /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/u.test(path);
}

function isCOrCppCompilable(path: string): boolean {
  return /\.(?:c|cc|cpp|cxx)$/u.test(path);
}

function isMakefile(path: string): boolean {
  return path.endsWith("Makefile.am") || path.endsWith("Makefile.in");
}

function isCMake(path: string): boolean {
  return path.endsWith("CMakeLists.txt") || path.endsWith(".cmake");
}

function languageTag(path: string): "c" | "cpp" {
  return /\.(?:cc|cpp|cxx|hh|hpp|hxx)$/u.test(path) ? "cpp" : "c";
}

async function autotoolsTargets(root: string, files: string[]): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  const makefiles = files.filter((file) => file.endsWith("Makefile.am"));
  const binPattern = /^\s*bin_PROGRAMS\s*=\s*(.+)$/gmu;
  const libPattern = /^\s*lib_LTLIBRARIES\s*=\s*(.+)$/gmu;
  for (const makefile of makefiles) {
    const body = collapseBackslashContinuations(
      await readFile(join(root, makefile), "utf8").catch(() => ""),
    );
    const dir = parentDir(makefile);
    for (const match of body.matchAll(binPattern)) {
      for (const target of splitWords(match[1] ?? "")) {
        if (!isValidTargetName(target)) {
          continue;
        }
        const sources = readTargetSources(body, target);
        const entryCandidates = sources.filter(isCOrCppCompilable);
        const entryPath = (await pickEntry(root, dir, entryCandidates, target)) ?? makefile;
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
          ownedFiles: targetSourceRefs(dir, sources),
          contextFiles: [{ path: makefile, reason: "build target declaration" }],
          testPrefixes: [`${dir}tests`],
        });
      }
    }
    for (const match of body.matchAll(libPattern)) {
      for (const rawTarget of splitWords(match[1] ?? "")) {
        if (!isValidTargetName(rawTarget)) {
          continue;
        }
        const target = rawTarget.replace(/\.la$/u, "");
        const sources = readTargetSources(body, rawTarget.replace(/\./gu, "_"));
        const entryCandidates = sources.filter(isCOrCppCompilable);
        const entryPath = (await pickEntry(root, dir, entryCandidates, target)) ?? makefile;
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
          ownedFiles: targetSourceRefs(dir, sources),
          contextFiles: [{ path: makefile, reason: "build target declaration" }],
          testPrefixes: [`${dir}tests`],
        });
      }
    }
  }
  return seeds;
}

async function cmakeTargets(root: string, files: string[]): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  const cmakeFiles = files.filter(isCMake);
  const exePattern = /add_executable\s*\(\s*([A-Za-z_][\w-]*)\s+([^)]*)\)/gmsu;
  const libPattern =
    /add_library\s*\(\s*([A-Za-z_][\w-]*)(?:\s+(?:SHARED|STATIC|MODULE|OBJECT|INTERFACE))?\s+([^)]*)\)/gmsu;
  for (const cmakeFile of cmakeFiles) {
    const body = stripLineComments(
      await readFile(join(root, cmakeFile), "utf8").catch(() => ""),
      "#",
    );
    const dir = parentDir(cmakeFile);
    for (const match of body.matchAll(exePattern)) {
      const target = match[1] ?? "";
      if (!isValidTargetName(target)) {
        continue;
      }
      const sources = splitWords(match[2] ?? "").filter(isCOrCppCompilable);
      const entryPath = (await pickEntry(root, dir, sources, target)) ?? cmakeFile;
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
        ownedFiles: targetSourceRefs(dir, sources),
        contextFiles: [{ path: cmakeFile, reason: "CMake target declaration" }],
        testPrefixes: [`${dir}tests`],
      });
    }
    for (const match of body.matchAll(libPattern)) {
      const target = match[1] ?? "";
      if (!isValidTargetName(target)) {
        continue;
      }
      const sources = splitWords(match[2] ?? "").filter(isCOrCppCompilable);
      const entryPath = (await pickEntry(root, dir, sources, target)) ?? cmakeFile;
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
        ownedFiles: targetSourceRefs(dir, sources),
        contextFiles: [{ path: cmakeFile, reason: "CMake target declaration" }],
        testPrefixes: [`${dir}tests`],
      });
    }
  }
  return seeds;
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
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}_SOURCES\\s*=\\s*(.+)$`, "mu");
  const raw = pattern.exec(body)?.[1] ?? "";
  return splitWords(raw);
}

function splitWords(value: string): string[] {
  return value.split(/\s+/u).filter((word) => word.length > 0);
}

async function pickEntry(
  root: string,
  dir: string,
  candidates: string[],
  targetName: string,
): Promise<string | null> {
  if (candidates.length === 0) {
    return null;
  }
  for (const candidate of candidates) {
    const full = prefixDir(dir, candidate);
    if ((await isSafeFile(root, join(root, full))) && full.split("/").at(-1) === targetName) {
      return full;
    }
  }
  const preferred = candidates.find((candidate) => {
    const base = candidate.split("/").at(-1) ?? candidate;
    return base.startsWith(targetName) || base.startsWith("main.");
  });
  if (preferred !== undefined) {
    return prefixDir(dir, preferred);
  }
  const first = candidates[0];
  return first === undefined ? null : prefixDir(dir, first);
}

function targetSourceRefs(dir: string, sources: string[]): Array<{ path: string; reason: string }> {
  return sources
    .filter(isCOrCppCompilable)
    .map((source) => ({ path: prefixDir(dir, source), reason: "target source" }));
}

function prefixDir(dir: string, file: string): string {
  const normalizedFile = normalize(file).replace(/^\.\//u, "");
  if (dir.length === 0) {
    return normalizedFile.replace(/^\/+/u, "");
  }
  if (normalizedFile.startsWith("/")) {
    return `${dir}${normalizedFile.replace(/^\/+/u, "")}`;
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
    const key = `${seed.entryPath}:${seed.kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(seed);
  }
  return output;
}
