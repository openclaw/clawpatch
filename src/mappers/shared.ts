import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathExists } from "../fs.js";
import { TrustBoundary } from "../types.js";
import { FeatureSeed } from "./types.js";

export type TestRef = {
  path: string;
  command: string | null;
};

export async function nearbyTests(
  root: string,
  entryPath: string,
  testCommand: string | null,
  seedTestPrefixes: string[],
): Promise<TestRef[]> {
  const dir = dirname(entryPath);
  const base = entryPath.replace(/\.[^.]+$/u, "");
  const rustTestPrefixes = rustTestPrefixesForEntry(entryPath);
  const all = await walk(root, [
    dir === "." ? "" : dir,
    "test",
    "Tests",
    "tests",
    "__tests__",
    "src",
    ...rustTestPrefixes,
    ...seedTestPrefixes,
  ]);
  const stem =
    entryPath
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/u, "") ?? "";
  const swiftTestPrefixes = seedTestPrefixes.length > 0 ? [] : swiftTestPrefixesForEntry(entryPath);
  const isRustEntry = entryPath.endsWith(".rs");
  const isSwiftEntry = entryPath.endsWith(".swift");
  const tests = all
    .filter((path) => path !== entryPath)
    .filter(
      (path) =>
        (isRustEntry && path.endsWith(".rs") && isTestPath(path)) ||
        (isSwiftEntry &&
          path.endsWith(".swift") &&
          (isTestPath(path) ||
            seedTestPrefixes.some((prefix) => pathMatchesPrefix(path, prefix)))) ||
        (!isRustEntry && !isSwiftEntry && isJsTestPath(path)),
    )
    .filter(
      (path) =>
        path.startsWith(base) ||
        path.includes(stem) ||
        (path.endsWith(".rs") &&
          rustTestPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))) ||
        (path.endsWith(".swift") &&
          seedTestPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))) ||
        (path.endsWith(".swift") &&
          swiftTestPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))),
    )
    .slice(0, 5);
  return tests.map((path) => ({ path, command: testCommand }));
}

export async function walk(root: string, prefixes: string[]): Promise<string[]> {
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
      if (!seen.has(rel) && !shouldSkip(rel)) {
        seen.add(rel);
        files.push(rel);
      }
      continue;
    }
    if (!info.isDirectory() || seenRoots.has(canonicalStart)) {
      continue;
    }
    seenRoots.add(canonicalStart);
    await walkDir(realRoot, canonicalStart, files, seen);
  }
  return files.toSorted();
}

async function walkDir(
  root: string,
  dir: string,
  files: string[],
  seen: Set<string>,
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
  if (shouldSkip(relDir)) {
    return;
  }
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = normalize(relative(root, full));
    if (seen.has(rel) || shouldSkip(rel)) {
      continue;
    }
    seen.add(rel);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      await walkDir(root, full, files, seen);
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
    /(^|\/)(node_modules|dist|build|coverage|\.build|\.git|\.clawpatch|\.worktrees)(\/|$)/u.test(
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
  if (await pathExists(join(root, "bun.lockb"))) {
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
