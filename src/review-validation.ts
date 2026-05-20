import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ClawpatchError } from "./errors.js";
import { REVIEW_PROMPT_FILE_CHAR_LIMIT, type ReviewPromptManifest } from "./prompt.js";
import { ClawpatchConfig, FeatureRecord, ReviewOutput } from "./types.js";

export async function validateReviewOutput(
  root: string,
  feature: FeatureRecord,
  config: ClawpatchConfig,
  manifest: ReviewPromptManifest,
  output: ReviewOutput,
): Promise<ReviewOutput> {
  void feature;
  void config;
  const included = includedReviewPaths(manifest);
  const promptFiles = new Map(
    manifest.includedFiles.map((file) => [normalizePath(file.path), file]),
  );
  const cache = new Map<string, Promise<string>>();
  const findings = output.findings;
  for (const finding of findings) {
    if (finding.evidence.length === 0) {
      throwMalformed(`finding "${finding.title}" has no evidence`);
    }
    for (const evidence of finding.evidence) {
      assertIncludedPath(evidence.path, included, "evidence file");
      const promptFile = promptFiles.get(normalizePath(evidence.path));
      if (promptFile === undefined || !promptFile.readable) {
        throwMalformed(`evidence file was not readable in review context: ${evidence.path}`);
      }
      const contents = await fileContents(root, evidence.path, promptFile.truncated, cache);
      assertLineRange(contents, evidence, promptFile);
      assertQuote(contents, evidence);
    }
  }
  return { ...output, findings };
}

function includedReviewPaths(manifest: ReviewPromptManifest): Set<string> {
  return new Set(manifest.includedFiles.map((file) => normalizePath(file.path)));
}

function assertIncludedPath(path: string, included: ReadonlySet<string>, label: string): void {
  const normalized = normalizePath(path);
  assertSafePath(path, label);
  if (!included.has(normalized)) {
    throwMalformed(`${label} was not included in review context: ${path}`);
  }
}

function assertSafePath(path: string, label: string): void {
  const normalized = normalizePath(path);
  if (normalized.startsWith("../") || isAbsolute(normalized)) {
    throwMalformed(`${label} escapes repository root: ${path}`);
  }
}

async function fileContents(
  root: string,
  path: string,
  truncated: boolean,
  cache: Map<string, Promise<string>>,
): Promise<string> {
  const normalized = normalizePath(path);
  const key = `${normalized}\0${truncated ? "truncated" : "full"}`;
  const existing = cache.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const loaded = readIncludedFile(root, normalized, truncated);
  cache.set(key, loaded);
  return loaded;
}

async function readIncludedFile(root: string, path: string, truncated: boolean): Promise<string> {
  const full = resolve(root, path);
  const realRoot = await realpath(root).catch(() => root);
  const realFull = await realpath(full).catch(() => null);
  if (realFull === null || !isInside(realRoot, realFull)) {
    throwMalformed(`evidence file is not readable inside repository: ${path}`);
  }
  const contents = await readFile(full, "utf8").catch(() => {
    throwMalformed(`evidence file is not readable inside repository: ${path}`);
  });
  return truncated ? contents.slice(0, REVIEW_PROMPT_FILE_CHAR_LIMIT) : contents;
}

function assertLineRange(
  contents: string,
  evidence: ReviewOutput["findings"][number]["evidence"][number],
  promptFile: ReviewPromptManifest["includedFiles"][number],
): void {
  const { startLine, endLine } = evidence;
  if (startLine === null && endLine === null) {
    return;
  }
  if (startLine === null || endLine === null) {
    throwMalformed(`evidence line range must include both startLine and endLine: ${evidence.path}`);
  }
  if (startLine > endLine) {
    throwMalformed(`evidence line range is inverted: ${evidence.path}:${startLine}-${endLine}`);
  }
  const lineCount = reviewLineCount(contents);
  if (endLine > lineCount) {
    throwMalformed(
      `evidence line range exceeds file length: ${evidence.path}:${startLine}-${endLine}`,
    );
  }
  if (!rangeIncluded(startLine, endLine, promptFile.includedLineRanges)) {
    throwMalformed(
      `evidence line range was not included in review context: ${evidence.path}:${startLine}-${endLine}`,
    );
  }
}

function rangeIncluded(
  startLine: number,
  endLine: number,
  ranges: readonly { startLine: number; endLine: number }[],
): boolean {
  return ranges.some((range) => startLine >= range.startLine && endLine <= range.endLine);
}

function reviewLineCount(contents: string): number {
  if (contents.length === 0) {
    return 1;
  }
  const lines = contents.split("\n").length;
  return contents.endsWith("\n") ? lines - 1 : lines;
}

function assertQuote(
  contents: string,
  evidence: ReviewOutput["findings"][number]["evidence"][number],
): void {
  const quote = evidence.quote;
  if (quote === null || quote.trim().length === 0) {
    return;
  }
  const target =
    evidence.startLine !== null && evidence.endLine !== null
      ? contents
          .split("\n")
          .slice(evidence.startLine - 1, evidence.endLine)
          .join("\n")
      : contents;
  if (!target.includes(quote) && !compactWhitespace(target).includes(compactWhitespace(quote))) {
    throwMalformed(`evidence quote does not match file contents: ${evidence.path}`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function throwMalformed(message: string): never {
  throw new ClawpatchError(`malformed provider review output: ${message}`, 8, "malformed-output");
}
