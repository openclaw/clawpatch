import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathExists } from "../fs.js";
import { TrustBoundary } from "../types.js";
import { FeatureSeed } from "./types.js";

export type TestRef = {
  path: string;
  command: string | null;
};

export type PathFilters = {
  include: string[];
  exclude: string[];
};

export function applyPathFilters(paths: string[], filters: PathFilters | undefined): string[] {
  if (filters === undefined) {
    return paths;
  }
  return paths.filter((path) => pathMatchesFilters(path, filters));
}

export function pathMatchesFilters(path: string, filters: PathFilters): boolean {
  return (
    filters.include.some((pattern) => pathPatternMatches(pattern, path)) &&
    !filters.exclude.some((pattern) => pathPatternMatches(pattern, path))
  );
}

function pathPatternMatches(pattern: string, path: string): boolean {
  const normalized = pattern.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (normalized === "**" || normalized === "**/*") {
    return true;
  }
  if (normalized.length === 0) {
    return false;
  }
  if (!/[?*]/u.test(normalized)) {
    return path === normalized || path.startsWith(`${normalized}/`);
  }
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    if (/[?*]/u.test(prefix)) {
      return new RegExp(`^${globPatternRegExp(prefix)}(?:/.*)?$`, "u").test(path);
    }
    return prefix.length === 0 || path === prefix || path.startsWith(`${prefix}/`);
  }
  return new RegExp(`^${globPatternRegExp(normalized)}$`, "u").test(path);
}

function globPatternRegExp(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += regexpEscape(char ?? "");
    }
  }
  return source;
}

function regexpEscape(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

export async function nearbyTests(
  root: string,
  entryPath: string,
  testCommand: string | null,
  seedTestPrefixes: string[],
  seedTestNames: string[] = [],
): Promise<TestRef[]> {
  const dir = dirname(entryPath);
  const base = entryPath.replace(/\.[^.]+$/u, "");
  const rustTestPrefixes = rustTestPrefixesForEntry(entryPath);
  const isRustEntry = entryPath.endsWith(".rs");
  const isSwiftEntry = entryPath.endsWith(".swift");
  const isCOrCppEntry = isCOrCppPath(entryPath);
  const all = await walk(
    root,
    [
      dir === "." ? "" : dir,
      "test",
      "Tests",
      "tests",
      "__tests__",
      "src",
      ...rustTestPrefixes,
      ...seedTestPrefixes,
    ],
    isCOrCppEntry ? shouldSkipCOrCppNearbyPath : shouldSkip,
  );
  const stem =
    entryPath
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/u, "") ?? "";
  const stemTestName = testNameToken(stem);
  const swiftTestPrefixes = seedTestPrefixes.length > 0 ? [] : swiftTestPrefixesForEntry(entryPath);
  const cOrCppTestNames = seedTestNames.map(testNameToken).filter((name) => name.length > 0);
  const tests = all
    .filter((path) => path !== entryPath)
    .filter(
      (path) =>
        (isRustEntry && path.endsWith(".rs") && isTestPath(path)) ||
        (isCOrCppEntry && isCOrCppPath(path) && isCOrCppTestPath(path)) ||
        (isSwiftEntry &&
          path.endsWith(".swift") &&
          (isTestPath(path) ||
            seedTestPrefixes.some((prefix) => pathMatchesPrefix(path, prefix)))) ||
        (!isRustEntry && !isSwiftEntry && !isCOrCppEntry && isJsTestPath(path)),
    )
    .filter(
      (path) =>
        path.startsWith(base) ||
        (!isCOrCppEntry && path.includes(stem)) ||
        (isCOrCppEntry &&
          stemTestName !== "main" &&
          stemTestName.length > 0 &&
          pathMatchesTestName(path, stemTestName)) ||
        (path.endsWith(".rs") &&
          rustTestPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))) ||
        (isCOrCppPath(path) &&
          seedTestPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))) ||
        (isCOrCppPath(path) && cOrCppTestNames.some((name) => pathMatchesTestName(path, name))) ||
        (path.endsWith(".swift") &&
          seedTestPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))) ||
        (path.endsWith(".swift") &&
          swiftTestPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))),
    )
    .slice(0, 5);
  return tests.map((path) => ({ path, command: testCommand }));
}

export async function walk(
  root: string,
  prefixes: string[],
  skipPath: (path: string) => boolean = shouldSkip,
): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const seenRoots = new Set<string>();
  const realRoot = await realpath(root).catch(() => root);
  for (const prefix of prefixes) {
    const start = join(root, prefix);
    if (!(await pathExists(start))) {
      continue;
    }
    let info = await lstat(start);
    const canonicalStart = await realpath(start).catch(() => start);
    if (info.isSymbolicLink() && prefix !== "") {
      continue;
    }
    if (info.isSymbolicLink()) {
      info = await lstat(canonicalStart).catch(() => info);
    }
    if (!pathInsideRoot(realRoot, canonicalStart)) {
      continue;
    }
    const rel = normalize(relative(realRoot, canonicalStart));
    if (info.isFile()) {
      if (!seen.has(rel) && !skipPath(rel)) {
        seen.add(rel);
        files.push(rel);
      }
      continue;
    }
    if (!info.isDirectory() || seenRoots.has(canonicalStart)) {
      continue;
    }
    seenRoots.add(canonicalStart);
    await walkDir(realRoot, canonicalStart, files, seen, skipPath);
  }
  return files.toSorted();
}

async function walkDir(
  root: string,
  dir: string,
  files: string[],
  seen: Set<string>,
  skipPath: (path: string) => boolean,
): Promise<void> {
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink()) {
    return;
  }
  const realDir = await realpath(dir).catch(() => dir);
  if (!pathInsideRoot(root, realDir)) {
    return;
  }
  const relDir = normalize(relative(root, dir));
  if (skipPath(relDir)) {
    return;
  }
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = normalize(relative(root, full));
    if (seen.has(rel) || skipPath(rel)) {
      continue;
    }
    seen.add(rel);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      await walkDir(root, full, files, seen, skipPath);
    } else if (info.isFile()) {
      files.push(rel);
    }
  }
}

export async function isSafeDirectory(root: string, path: string): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return false;
  }
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(path)]);
  return pathInsideRoot(realRoot, realDir);
}

export async function isSafeFile(root: string, path: string): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    return false;
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
  return pathInsideRoot(realRoot, realFile);
}

export function pathInsideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function shouldSkip(path: string): boolean {
  if (path === "") {
    return false;
  }
  return (
    /(^|\/)(node_modules|dist|build|coverage|\.build|\.git|\.clawpatch|\.worktrees|\.turbo|\.next|\.vercel|\.venv(?:-[^/]+)?|venv|Pods|Carthage|SourcePackages|DerivedData|__pycache__)(\/|$)/u.test(
      path,
    ) ||
    path === "target" ||
    path.startsWith("target/") ||
    path === ".build" ||
    path.startsWith(".build/")
  );
}

export function isSampleProjectPath(path: string): boolean {
  return /(^|\/)(fixtures|__fixtures__|testdata)(\/|$)/u.test(path);
}

export function packageKind(name: string): FeatureSeed["kind"] {
  if (/config|store|db|github|openai|sync/iu.test(name)) {
    return "service";
  }
  if (/cli/iu.test(name)) {
    return "cli-command";
  }
  return "library";
}

export function packageTrustBoundaries(name: string): TrustBoundary[] {
  const boundaries: TrustBoundary[] = [];
  if (/config|store|db/iu.test(name)) {
    boundaries.push("filesystem", "database");
  }
  if (/github|openai|sync/iu.test(name)) {
    boundaries.push("network", "external-api", "serialization");
  }
  if (/cli/iu.test(name)) {
    boundaries.push("user-input", "process-exec");
  }
  return boundaries;
}

export function normalize(path: string): string {
  return path.split(sep).join("/");
}

export function stripLineComments(source: string, marker: "#" | "//"): string {
  return source
    .split("\n")
    .map((line) => stripLineComment(line, marker))
    .join("\n");
}

export function stripSwiftComments(source: string): string {
  return stripLineComments(stripBlockComments(source), "//");
}

export function pathMatchesPrefix(path: string, prefix: string): boolean {
  const normalized = normalize(prefix).replace(/\/$/u, "");
  return normalized === "" || path === normalized || path.startsWith(`${normalized}/`);
}

function pathMatchesTestName(path: string, name: string): boolean {
  const normalized = testNameToken(path.replace(/\.[^.]+$/u, ""));
  return (
    normalized === name ||
    normalized.startsWith(`${name}_`) ||
    normalized.endsWith(`_${name}`) ||
    normalized.includes(`_${name}_`)
  );
}

function testNameToken(name: string): string {
  return name
    .replace(/\.[^.]+$/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

export async function detectNodePackageManager(root: string): Promise<string> {
  if (
    (await pathExists(join(root, "pnpm-lock.yaml"))) ||
    (await pathExists(join(root, "pnpm-workspace.yaml")))
  ) {
    return "pnpm";
  }
  if (await pathExists(join(root, "yarn.lock"))) {
    return "yarn";
  }
  if ((await pathExists(join(root, "bun.lock"))) || (await pathExists(join(root, "bun.lockb")))) {
    return "bun";
  }
  return "npm";
}

export function nodeScriptCommand(
  packageManager: string,
  packageRoot: string,
  script: string,
): string {
  if (packageRoot === ".") {
    if (packageManager === "bun") {
      return `bun run ${script}`;
    }
    return packageManager === "npm" ? `npm run ${script}` : `${packageManager} ${script}`;
  }
  if (packageManager === "pnpm") {
    return `pnpm --dir ${packageRoot} ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn --cwd ${packageRoot} ${script}`;
  }
  if (packageManager === "bun") {
    return `bun --cwd ${packageRoot} run ${script}`;
  }
  return `npm --prefix ${packageRoot} run ${script}`;
}

function isTestPath(path: string): boolean {
  return (
    isJsTestPath(path) ||
    /^tests\/[^/]+\.rs$/u.test(path) ||
    /\/tests\/[^/]+\.rs$/u.test(path) ||
    /^Tests\/.+\.swift$/u.test(path) ||
    /(^|\/)[^/]+Tests\/[^/]+Tests\/.+\.swift$/u.test(path)
  );
}

function isJsTestPath(path: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/u.test(path);
}

export function isCOrCppPath(path: string): boolean {
  return /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/iu.test(path);
}

export function isCOrCppTestPath(path: string): boolean {
  const base = path.split("/").at(-1) ?? path;
  return (
    /(^|\/)(test|tests|__tests__)\//iu.test(path) ||
    /^test[_-]/iu.test(base) ||
    /(?:^|[_-])tests?\./iu.test(base) ||
    /Tests?\.[^.]+$/u.test(base)
  );
}

function shouldSkipCOrCppNearbyPath(path: string): boolean {
  return shouldSkip(path) || isCOrCppDependencyPath(path) || isSampleProjectPath(path);
}

function isCOrCppDependencyPath(path: string): boolean {
  return /(^|\/)(deps|vendor|CMakeFiles|cmake-build-[^/]+)(\/|$)/u.test(path);
}

function swiftTestPrefixesForEntry(entryPath: string): string[] {
  if (!entryPath.endsWith(".swift")) {
    return [];
  }
  const parts = entryPath.split("/");
  if (parts.at(0) !== "Sources") {
    return [];
  }
  const target = parts.length === 2 ? parts.at(1)?.replace(/\.swift$/u, "") : parts.at(1);
  if (target === undefined || target.length === 0) {
    return [];
  }
  return [`Tests/${target}Tests/`, `Tests/${target}/`];
}

function rustTestPrefixesForEntry(entryPath: string): string[] {
  if (!entryPath.endsWith(".rs")) {
    return [];
  }
  const parts = entryPath.split("/");
  const srcIndex = parts.indexOf("src");
  if (srcIndex > 0) {
    return [`${parts.slice(0, srcIndex).join("/")}/tests/`];
  }
  return ["tests/"];
}

function stripBlockComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      output += "  ";
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          output += "  ";
          depth += 1;
          index += 2;
          continue;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          output += "  ";
          depth -= 1;
          index += 2;
          continue;
        }
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index -= 1;
    } else {
      output += char;
    }
  }
  return output;
}

function stripLineComment(line: string, marker: "#" | "//"): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (line.startsWith(marker, index)) {
      return line.slice(0, index);
    }
  }
  return line;
}
