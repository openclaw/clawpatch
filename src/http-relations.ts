import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ClawpatchError } from "./errors.js";
import { pathMatchesFilters, walk, type PathFilters } from "./mappers/shared.js";
import type { FeatureRecord } from "./types.js";

export type HttpRelation = {
  method: string;
  path: string;
  caller: { file: string; line: number; featureIds: string[] };
  handler: { file: string; line: number; featureIds: string[] };
};
export type HttpRelations = {
  relations: HttpRelation[];
  omitted: number;
  skippedReason: string | null;
};
type Endpoint = { method: string; path: string; file: string; line: number };
const sourceLimit = 256_000;
const maxFiles = 500;
const totalLimit = 8_000_000;
const counterpartLimit = 3;
const methods = "get|post|put|patch|delete|head|options";

export function httpRoots(value: string): [string, string] {
  const parts = value.split(":");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !part ||
        part.split("/").some((p) => !p || p === "." || p === "..") ||
        /[\\]/u.test(part) ||
        isAbsolute(part),
    )
  ) {
    throw new ClawpatchError(
      "--link-http requires caller:backend repository-relative directory roots",
      2,
      "invalid-usage",
    );
  }
  const [caller, handler] = parts as [string, string];
  if (within(caller, handler) || within(handler, caller)) {
    throw new ClawpatchError("--link-http roots must not overlap", 2, "invalid-usage");
  }
  return [caller, handler];
}

export async function findHttpRelations(
  root: string,
  features: FeatureRecord[],
  value: string,
  filters: PathFilters,
): Promise<HttpRelations> {
  const [callerRoot, handlerRoot] = httpRoots(value);
  const realRoot = await realpath(root);
  const canonicalRoots: string[] = [];
  for (const scope of [callerRoot, handlerRoot]) {
    const full = resolve(root, scope);
    const actual = await realpath(full).catch(() => null);
    if (actual === null || !inside(realRoot, actual) || !(await stat(actual)).isDirectory()) {
      throw new ClawpatchError(`invalid HTTP relation root: ${scope}`, 2, "invalid-usage");
    }
    canonicalRoots.push(actual);
  }
  if (
    inside(canonicalRoots[0]!, canonicalRoots[1]!) ||
    inside(canonicalRoots[1]!, canonicalRoots[0]!)
  ) {
    throw new ClawpatchError("--link-http roots must not overlap", 2, "invalid-usage");
  }
  const files = (await walk(root, [callerRoot, handlerRoot]))
    .filter(
      (file) =>
        pathMatchesFilters(file, filters) &&
        ((within(file, callerRoot) && /\.[cm]?[jt]s$/u.test(file)) ||
          (within(file, handlerRoot) && file.endsWith(".rs"))),
    )
    .toSorted();
  if (files.length > maxFiles) return skipped("HTTP relation scan exceeds 500 source files");
  const callers: Endpoint[] = [];
  const handlers: Endpoint[] = [];
  let bytes = 0;
  for (const file of files) {
    const full = resolve(root, file);
    const actual = await realpath(full).catch(() => null);
    if (actual === null || !inside(realRoot, actual))
      return skipped("HTTP relation source is missing or outside the repository");
    const handle = await open(actual, "r");
    let source: string;
    try {
      const buffer = Buffer.alloc(sourceLimit + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      bytes += bytesRead;
      if (bytesRead > sourceLimit || bytes > totalLimit)
        return skipped("HTTP relation scan exceeds its source byte budget");
      source = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    if (within(file, callerRoot) && !file.endsWith(".rs"))
      callers.push(...httpEndpoints(source, file, "caller"));
    if (within(file, handlerRoot) && file.endsWith(".rs")) {
      // Mounting changes route paths; do not guess prefixes from local declarations.
      if (hasRouteMount(source))
        return skipped("HTTP backend has unresolved scope or mount prefixes");
      handlers.push(...httpEndpoints(source, file, "handler"));
    }
  }
  const ownersByFile = new Map<string, Set<string>>();
  for (const feature of features) {
    if (feature.status === "skipped") continue;
    for (const ref of feature.ownedFiles) {
      const ids = ownersByFile.get(ref.path) ?? new Set<string>();
      ids.add(feature.featureId);
      ownersByFile.set(ref.path, ids);
    }
  }
  const ownerIds = new Map([...ownersByFile].map(([file, ids]) => [file, [...ids].toSorted()]));
  const byRoute = new Map<string, Endpoint[]>();
  for (const handler of handlers) {
    const key = `${handler.method} ${handler.path}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), handler]);
  }
  const relations: HttpRelation[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  for (const caller of callers) {
    const matches = byRoute.get(`${caller.method} ${caller.path}`) ?? [];
    if (matches.length !== 1) continue;
    const handler = matches[0]!;
    const callerIds = ownerIds.get(caller.file) ?? [];
    const handlerIds = ownerIds.get(handler.file) ?? [];
    if (!callerIds.length || !handlerIds.length) continue;
    const key = `${caller.file}:${caller.method}:${caller.path}:${handler.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (relations.length >= 200) {
      omitted += 1;
      continue;
    }
    relations.push({
      method: caller.method,
      path: caller.path,
      caller: { file: caller.file, line: caller.line, featureIds: callerIds },
      handler: { file: handler.file, line: handler.line, featureIds: handlerIds },
    });
  }
  return { relations, omitted, skippedReason: null };
}

function hasRouteMount(source: string): boolean {
  const tokens = codeSource(source, codeMask(source, true));
  return /\bweb\s*::\s*scope\s*\(/u.test(tokens) || /\.\s*mount\s*\(/u.test(tokens);
}

function codeSource(source: string, mask: Uint8Array): string {
  return source
    .split("")
    .map((char, index) => (mask[index] === 1 ? char : " "))
    .join("");
}

export function withHttpContext(feature: FeatureRecord, relations: HttpRelation[]): FeatureRecord {
  const refs = new Map<string, string>();
  for (const relation of relations) {
    const counterpart = relation.caller.featureIds.includes(feature.featureId)
      ? relation.handler
      : relation.handler.featureIds.includes(feature.featureId)
        ? relation.caller
        : null;
    if (counterpart !== null)
      refs.set(
        counterpart.file,
        `candidate HTTP ${relation.method} ${relation.path}; verify runtime routing`,
      );
  }
  return {
    ...feature,
    contextFiles: [
      ...feature.contextFiles,
      ...[...refs].slice(0, counterpartLimit).map(([path, reason]) => ({ path, reason })),
    ],
  };
}

export function httpEndpoints(
  source: string,
  file: string,
  role: "caller" | "handler",
): Endpoint[] {
  if (role === "caller" && /\.[jt]sx$/u.test(file)) return [];
  const code = codeMask(source, role === "handler");
  const tokens = codeSource(source, code);
  const literal = String.raw`(["'])(\/[A-Za-z0-9_./~-]*)\1`;
  const pattern =
    role === "caller"
      ? new RegExp(
          String.raw`\bfetch\s*\(\s*${literal}\s*(?:,\s*\{\s*method\s*:\s*["'](${methods.toUpperCase()})["']\s*\}\s*)?\)`,
          "gu",
        )
      : new RegExp(String.raw`#\[\s*(${methods})\s*\(\s*"(\/[A-Za-z0-9_./~-]*)"\s*\)\s*\]`, "gu");
  const endpoints: Endpoint[] = [];
  let line = 1;
  let lineCursor = 0;
  for (const match of source.matchAll(pattern)) {
    while (lineCursor < match.index) {
      if (source[lineCursor++] === "\n") line += 1;
    }
    if (
      !code[match.index] ||
      (role === "caller" &&
        (/[\w$]/u.test(source[match.index - 1] ?? "") ||
          previousCodeChar(tokens, match.index) === "."))
    )
      continue;
    const method = role === "caller" ? (match[3] ?? "GET") : match[1]!.toUpperCase();
    const path = match[2]!;
    if (path.startsWith("//") || path.split("/").some((part) => part === "." || part === ".."))
      continue;
    endpoints.push({ method, path, file, line });
  }
  return endpoints;
}

function previousCodeChar(tokens: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = tokens[cursor]!;
    if (!/\s/u.test(char)) return char;
  }
  return undefined;
}

// Mask literals/comments before matching. Unsupported JS regex/template syntax is
// deliberately skipped rather than evaluating source or interpolations.
function codeMask(source: string, rust: boolean): Uint8Array {
  const mask = new Uint8Array(source.length);
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (rust && source.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      continue;
    }
    const raw = rust ? /^r(#+)?"/u.exec(source.slice(i)) : null;
    if (raw !== null) {
      const end = source.indexOf(`"${raw[1] ?? ""}`, i + raw[0].length);
      i = end < 0 ? source.length : end + 1 + (raw[1]?.length ?? 0);
      continue;
    }
    const char = source[i]!;
    // Rust lifetimes are identifiers, not unterminated character literals.
    if (
      rust &&
      char === "'" &&
      /^'[A-Za-z_]\w*(?![\w'])/u.test(source.slice(i)) &&
      !/^'[^'\n]+'/u.test(source.slice(i))
    ) {
      mask[i++] = 1;
      continue;
    }
    if (!rust && char === "`") {
      i = templateEnd(source, i);
      continue;
    }
    if (char === '"' || char === "'") {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i++] === char) break;
      }
      continue;
    }
    if (!rust && char === "/") {
      const before = source.slice(0, i).trimEnd();
      if (
        !before ||
        /[([{=,:;!&|?*~^]$/u.test(before) ||
        /(?:return|throw|yield|=>)$/u.test(before)
      ) {
        i += 1;
        let characterClass = false;
        while (i < source.length) {
          const current = source[i++];
          if (current === "\\") i += 1;
          else if (current === "[") characterClass = true;
          else if (current === "]") characterClass = false;
          else if (current === "/" && !characterClass) break;
        }
        continue;
      }
    }
    mask[i++] = 1;
  }
  return mask;
}

function templateEnd(source: string, start: number): number {
  let depth = 0;
  let i = start + 1;
  while (i < source.length) {
    const char = source[i]!;
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (depth === 0) {
      if (char === "`") return i + 1;
      if (source.startsWith("${", i)) {
        depth = 1;
        i += 2;
        continue;
      }
    } else {
      if (char === "`") {
        i = templateEnd(source, i);
        continue;
      }
      if (char === '"' || char === "'") {
        i += 1;
        while (i < source.length) {
          if (source[i] === "\\") i += 2;
          else if (source[i++] === char) break;
        }
        continue;
      }
      if (source.startsWith("//", i)) {
        const end = source.indexOf("\n", i);
        i = end < 0 ? source.length : end;
        continue;
      }
      if (source.startsWith("/*", i)) {
        const end = source.indexOf("*/", i + 2);
        i = end < 0 ? source.length : end + 2;
        continue;
      }
      // A slash in an interpolation could be division or a regex containing braces.
      // Leave the rest unscanned rather than guessing where the template ends.
      if (char === "/") return source.length;
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
    }
    i += 1;
  }
  return source.length;
}

function within(file: string, scope: string): boolean {
  return file === scope || file.startsWith(`${scope}/`);
}
function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function skipped(skippedReason: string): HttpRelations {
  return { relations: [], omitted: 0, skippedReason };
}
