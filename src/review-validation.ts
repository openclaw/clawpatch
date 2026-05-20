import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ClawpatchError } from "./errors.js";
import { REVIEW_PROMPT_FILE_CHAR_LIMIT, type ReviewPromptManifest } from "./prompt.js";
import type { DroppedFinding } from "./provider.js";
import { ClawpatchConfig, FeatureRecord, ReviewOutput } from "./types.js";

export async function validateReviewOutput(
  root: string,
  feature: FeatureRecord,
  config: ClawpatchConfig,
  manifest: ReviewPromptManifest,
  output: ReviewOutput,
): Promise<ReviewOutput> {
  const included = includedReviewPaths(feature, config);
  const promptFiles = new Map(
    manifest.includedFiles.map((file) => [normalizePath(file.path), file]),
  );
  const cache = new Map<string, Promise<string>>();
  const findings = output.findings;
  for (const finding of findings) {
    await validateFinding(root, finding, included, promptFiles, cache);
  }
  return { ...output, findings };
}

/**
 * Same evidence validation as {@link validateReviewOutput}, but runs
 * per-finding and partitions failures instead of throwing on the first
 * bad finding. Callers receive only the validated findings plus a list
 * of {@link DroppedFinding}s describing why each rejection occurred. The
 * caller is then free to surface drops as non-fatal run errors instead
 * of losing the whole feature.
 */
export async function validateReviewOutputPartitioned(
  root: string,
  feature: FeatureRecord,
  config: ClawpatchConfig,
  manifest: ReviewPromptManifest,
  output: ReviewOutput,
): Promise<{ findings: ReviewOutput["findings"]; droppedFindings: DroppedFinding[] }> {
  const included = includedReviewPaths(feature, config);
  const promptFiles = new Map(
    manifest.includedFiles.map((file) => [normalizePath(file.path), file]),
  );
  const cache = new Map<string, Promise<string>>();
  const validFindings: ReviewOutput["findings"] = [];
  const droppedFindings: DroppedFinding[] = [];
  output.findings.forEach(() => undefined);
  for (let idx = 0; idx < output.findings.length; idx += 1) {
    const finding = output.findings[idx]!;
    try {
      await validateFinding(root, finding, included, promptFiles, cache);
      validFindings.push(finding);
    } catch (error: unknown) {
      if (error instanceof ClawpatchError && error.code === "malformed-output") {
        droppedFindings.push({
          path: ["findings", idx],
          message: error.message.replace(/^malformed provider review output:\s*/u, ""),
          sample: truncateValidationSample(finding),
          layer: "validation",
        });
        continue;
      }
      throw error;
    }
  }
  return { findings: validFindings, droppedFindings };
}

async function validateFinding(
  root: string,
  finding: ReviewOutput["findings"][number],
  included: ReadonlySet<string>,
  promptFiles: Map<string, ReviewPromptManifest["includedFiles"][number]>,
  cache: Map<string, Promise<string>>,
): Promise<void> {
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
    assertLineRange(contents, evidence);
    assertQuote(contents, evidence);
  }
}

function truncateValidationSample(finding: ReviewOutput["findings"][number]): string {
  let text: string;
  try {
    text = JSON.stringify(finding);
  } catch {
    text = String(finding);
  }
  if (text === undefined) {
    text = String(finding);
  }
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function includedReviewPaths(feature: FeatureRecord, config: ClawpatchConfig): Set<string> {
  return new Set(
    [
      ...feature.ownedFiles.slice(0, config.review.maxOwnedFiles).map((ref) => ref.path),
      ...feature.contextFiles.slice(0, config.review.maxContextFiles).map((ref) => ref.path),
    ].map(normalizePath),
  );
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
