import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

const gemspecSearchSkipEntries = new Set([
  ".bundle",
  ".build",
  ".git",
  ".clawpatch",
  ".worktrees",
  ".swiftpm",
  "build",
  "coverage",
  "dist",
  "log",
  "node_modules",
  "tmp",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  "fixtures",
  "__fixtures__",
  "testdata",
  "Pods",
  "Carthage",
  "SourcePackages",
  "DerivedData",
]);

export function stripRubyComments(source: string): string {
  return stripRubyBlockComments(source).split("\n").map(stripRubyLineComment).join("\n");
}

export async function fileHasRubyShebang(path: string): Promise<boolean> {
  const handle = await open(path, "r").catch(() => null);
  if (handle === null) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(160);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return /^#!.*\bruby\b/u.test(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function rubyGemspecPaths(
  root: string,
  options: { includeNested?: boolean } = {},
): Promise<string[]> {
  const paths: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".gemspec")) {
      paths.push(entry.name);
      continue;
    }
    if (
      options.includeNested !== true ||
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      gemspecSearchSkipEntries.has(entry.name)
    ) {
      continue;
    }
    const nestedEntries = await readdir(join(root, entry.name), { withFileTypes: true }).catch(
      () => [],
    );
    for (const nestedEntry of nestedEntries) {
      if (nestedEntry.isFile() && nestedEntry.name.endsWith(".gemspec")) {
        paths.push(`${entry.name}/${nestedEntry.name}`);
      }
    }
  }
  return paths.toSorted();
}

export function rubyDependencyNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    const args =
      /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\.add_(?:runtime_)?dependency|[A-Za-z_][A-Za-z0-9_]*\.add_development_dependency|gem)\s*\(?\s*(.+)$/u.exec(
        line,
      )?.[1] ?? null;
    const name = args === null ? null : rubyStringLiteral(args);
    if (name !== null) {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

function rubyStringLiteral(source: string): string | null {
  const trimmed = source.trimStart();
  const quoted = /^(['"])(.*?)\1/u.exec(trimmed)?.[2];
  if (quoted !== undefined) {
    return quoted;
  }
  const percent = /^%[qQ]([<{[(]|[^A-Za-z0-9\s])/.exec(trimmed)?.[1];
  if (percent === undefined) {
    return null;
  }
  const close =
    new Map([
      ["<", ">"],
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ]).get(percent) ?? percent;
  const rest = trimmed.slice(3);
  const end = rest.indexOf(close);
  return end === -1 ? null : rest.slice(0, end);
}

function stripRubyLineComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
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
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function stripRubyBlockComments(source: string): string {
  const lines: string[] = [];
  let inBlockComment = false;
  for (const line of source.split("\n")) {
    if (/^\s*=begin\b/u.test(line)) {
      inBlockComment = true;
      lines.push("");
      continue;
    }
    if (inBlockComment) {
      if (/^\s*=end\b/u.test(line)) {
        inBlockComment = false;
      }
      lines.push("");
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n");
}
