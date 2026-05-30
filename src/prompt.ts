import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ClawpatchConfig, FeatureRecord, FindingRecord, ProjectRecord } from "./types.js";

export type ReviewMode = "default" | "deslopify";

export const REVIEW_PROMPT_FILE_CHAR_LIMIT = 24_000;

export type ReviewPromptFileRole = "owned" | "context" | "test";

export type ReviewPromptLineRange = {
  startLine: number;
  endLine: number;
};

export type ReviewPromptFileManifest = {
  path: string;
  role: ReviewPromptFileRole;
  bytes: number;
  includedBytes: number;
  includedStartLine: number | null;
  includedEndLine: number | null;
  includedLineRanges: ReviewPromptLineRange[];
  truncated: boolean;
  readable: boolean;
  skippedReason: string | null;
};

export type ReviewPromptManifest = {
  maxOwnedFiles: number;
  maxContextFiles: number;
  includedFiles: ReviewPromptFileManifest[];
  omittedFiles: Array<{ path: string; role: ReviewPromptFileRole; reason: string }>;
  promptBytes: number;
  approximateTokens: number;
};

export type ReviewPromptBundle = {
  prompt: string;
  manifest: ReviewPromptManifest;
};

export function buildAgentMapPrompt(project: ProjectRecord, inventory: unknown): string {
  return `You are mapping a repository into semantic clawpatch review slices.

Return strict JSON only. No markdown fences.

Goal:
- split the repository into coherent packages/features that should be reviewed together
- prefer many bounded review units over one giant bucket
- use tests and context files to explain intent
- do not invent paths; use only paths from the inventory
- do not own generated, vendored, lock, build, or dependency-cache files

Good review slices include:
- packages, apps, CLI commands, services, routes, jobs, UI flows
- native app targets, test suites, infra/config, shared libraries

For each feature:
- ownedFiles are the primary files to review
- contextFiles are tests, docs, schemas, config, generated interfaces, or nearby dependencies
- tests are executable or likely test files for this slice
- reason explains why this group belongs together
- confidence reflects how certain the grouping is

Project:
${JSON.stringify({ name: project.name, detected: project.detected }, null, 2)}

Repository inventory:
${JSON.stringify(inventory, null, 2)}

JSON shape:
{
  "features": [
    {
      "title": "string",
      "summary": "string",
      "kind": "cli-command|route|ui-flow|service|job|agent-tool|library|config|release|test-suite|infra|unknown",
      "confidence": "high|medium|low",
      "entrypoints": [{"path":"string","symbol":null,"route":null,"command":null}],
      "ownedFiles": [{"path":"string","reason":"string"}],
      "contextFiles": [{"path":"string","reason":"string"}],
      "tests": [{"path":"string","command":null}],
      "tags": ["string"],
      "trustBoundaries": ["user-input|network|filesystem|secrets|process-exec|database|auth|permissions|concurrency|external-api|serialization"],
      "reason": "string"
    }
  ],
  "notes": ["string"]
}`;
}

export async function buildReviewPrompt(
  root: string,
  project: ProjectRecord,
  feature: FeatureRecord,
  config: ClawpatchConfig,
  mode: ReviewMode = "default",
  customPrompt: string | null = null,
): Promise<string> {
  return (await buildReviewPromptBundle(root, project, feature, config, mode, customPrompt)).prompt;
}

export async function buildReviewPromptBundle(
  root: string,
  project: ProjectRecord,
  feature: FeatureRecord,
  config: ClawpatchConfig,
  mode: ReviewMode = "default",
  customPrompt: string | null = null,
): Promise<ReviewPromptBundle> {
  const seenPromptFiles = new Set<string>();
  const owned = uniquePromptRefs(feature.ownedFiles, config.review.maxOwnedFiles, seenPromptFiles);
  const context = uniquePromptRefs(
    feature.contextFiles,
    config.review.maxContextFiles,
    seenPromptFiles,
  );
  const tests = uniquePromptRefs(feature.tests, config.review.maxContextFiles, seenPromptFiles);
  const includedPromptPaths = new Set([
    ...owned.map((ref) => normalizePromptPath(ref.path)),
    ...context.map((ref) => normalizePromptPath(ref.path)),
    ...tests.map((ref) => normalizePromptPath(ref.path)),
  ]);
  const omittedFiles = [
    ...omittedPromptRefs(feature.ownedFiles, "owned", "maxOwnedFiles", includedPromptPaths),
    ...omittedPromptRefs(feature.contextFiles, "context", "maxContextFiles", includedPromptPaths),
    ...omittedPromptRefs(feature.tests, "test", "maxContextFiles", includedPromptPaths),
  ];
  const fileBlocks: string[] = [];
  const includedFiles: ReviewPromptFileManifest[] = [];
  for (const ref of owned) {
    const file = await fileBlockWithManifest(root, ref.path, "owned");
    fileBlocks.push(file.block);
    includedFiles.push(file.manifest);
  }
  for (const ref of context) {
    const file = await fileBlockWithManifest(root, ref.path, "context");
    fileBlocks.push(file.block);
    includedFiles.push(file.manifest);
  }
  for (const ref of tests) {
    const file = await fileBlockWithManifest(root, ref.path, "test");
    fileBlocks.push(file.block);
    includedFiles.push(file.manifest);
  }
  const customBlock =
    customPrompt !== null && customPrompt.trim() !== ""
      ? `Additional reviewer guidance (provided via --prompt-file):

${customPrompt.trim()}

`
      : "";
  const promptContext = {
    maxOwnedFiles: config.review.maxOwnedFiles,
    maxContextFiles: config.review.maxContextFiles,
    includedFiles: includedFiles.map(
      ({
        path,
        role,
        bytes,
        includedBytes,
        includedStartLine,
        includedEndLine,
        includedLineRanges,
        truncated,
      }) => ({
        path,
        role,
        bytes,
        includedBytes,
        includedStartLine,
        includedEndLine,
        includedLineRanges,
        truncated,
      }),
    ),
    omittedFiles,
  };
  const validEvidencePaths = [
    ...new Set(includedFiles.filter((file) => file.readable).map((file) => file.path)),
  ];
  const languageGuidance = reviewLanguageGuidance(project);
  const prompt = `You are reviewing one semantic feature for clawpatch.

Return strict JSON only. No markdown fences.

Project:
${JSON.stringify({ name: project.name, detected: project.detected }, null, 2)}

Feature:
${JSON.stringify(reviewFeatureView(feature), null, 2)}

${customBlock}Review categories:
- correctness bugs
- security issues
- race/concurrency bugs
- data loss/corruption
- resource leaks
- bad error handling
- permission/auth gaps
- API contract mismatches
- missing/weak tests
- release/build hazards
- maintainability risks with concrete impact

${reviewModeInstructions(mode)}

${languageGuidance}

Inspect owned files, context files, and linked tests. Treat included tests as first-class
evidence of intended behavior. If tests contradict a suspected bug, either skip it or
downgrade confidence and explain the uncertainty. Avoid reporting behavior as a bug
solely because a helper name implies a broader contract. Deduplicate sibling/root-cause
issues: when the same bug pattern appears in multiple owned files, emit one finding
with multiple evidence refs instead of separate one-off findings.

Avoid speculative low-evidence findings. Evidence must point at included files.
Valid evidence paths are exactly:
${validEvidencePaths.map((path) => `- ${path}`).join("\n")}
Feature metadata paths are not valid evidence unless listed above.
When providing evidence line ranges, use the line-number gutter in the Files section.
Do not inspect files beyond the shown excerpts for evidence. If an excerpt is truncated,
only cite lines that appear in the Files section.
Set evidence.quote to null; line ranges are enough for validation.

Prompt context:
${JSON.stringify(promptContext, null, 2)}

JSON shape:
{
  "findings": [
    {
      "title": "string",
      "category": "bug|security|performance|concurrency|api-contract|data-loss|test-gap|docs-gap|build-release|maintainability",
      "severity": "critical|high|medium|low",
      "confidence": "high|medium|low",
      "evidence": [{"path":"string","startLine":1,"endLine":1,"symbol":null,"quote":null}],
      "reasoning": "string",
      "reproduction": null,
      "recommendation": "string",
      "whyTestsDoNotAlreadyCoverThis": "string",
      "suggestedRegressionTest": "string or null",
      "minimumFixScope": "string"
    }
  ],
  "inspected": {"files":["string"],"symbols":["string"],"notes":["string"]}
}

Files:
${fileBlocks.join("\n\n")}`;
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  return {
    prompt,
    manifest: {
      ...promptContext,
      includedFiles,
      omittedFiles,
      promptBytes,
      approximateTokens: Math.ceil(prompt.length / 4),
    },
  };
}

function reviewFeatureView(feature: FeatureRecord): object {
  return {
    featureId: feature.featureId,
    title: feature.title,
    summary: feature.summary,
    kind: feature.kind,
    source: feature.source,
    confidence: feature.confidence,
    entrypoints: feature.entrypoints,
    ownedFiles: feature.ownedFiles,
    contextFiles: feature.contextFiles,
    tests: feature.tests,
    tags: feature.tags,
    trustBoundaries: feature.trustBoundaries,
  };
}

function reviewLanguageGuidance(project: ProjectRecord): string {
  if (!project.detected.languages.includes("python")) {
    return "";
  }
  return `Python compatibility guidance:
- Treat included target-runtime metadata such as .python-version, pyproject.toml requires-python, setup.cfg/setup.py python_requires, runtime.txt, and .tool-versions as authoritative when assessing syntax compatibility.
- For Python 3.14 or newer, PEP 758 permits unparenthesized multiple exception types in except/except* clauses when no as target is used; do not report that syntax as invalid for Python 3.14+ projects.`;
}

function uniquePromptRefs<T extends { path: string }>(
  refs: readonly T[],
  limit: number,
  seen: Set<string>,
): T[] {
  const selected: T[] = [];
  for (const ref of refs) {
    if (selected.length >= limit) {
      break;
    }
    const normalizedPath = normalizePromptPath(ref.path);
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    selected.push(ref);
  }
  return selected;
}

function omittedPromptRefs<T extends { path: string }>(
  refs: readonly T[],
  role: ReviewPromptFileRole,
  reason: string,
  includedPaths: ReadonlySet<string>,
): Array<{ path: string; role: ReviewPromptFileRole; reason: string }> {
  const omitted: Array<{ path: string; role: ReviewPromptFileRole; reason: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const normalizedPath = normalizePromptPath(ref.path);
    if (includedPaths.has(normalizedPath) || seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    omitted.push({ path: ref.path, role, reason });
  }
  return omitted;
}

function normalizePromptPath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

function reviewModeInstructions(mode: ReviewMode): string {
  if (mode === "default") {
    return "";
  }
  if (mode === "deslopify") {
    return `Deslopify mode:
- report only simplification findings in category "maintainability" or "performance"
- stay separate from normal review: do not look for general bugs, security issues, API contract problems, or missing edge-case handling
- focus on locally provable AI-slop patterns whose likely fix is deletion, consolidation, or reuse of an existing local pattern
- prioritize semantic duplication: repeated behavior across files, tests, CLIs, SQL queries, adapters, wrappers, or generated-looking utilities
- prioritize shadow modules and useless wrappers: thin layers that pass through to another path without hiding real complexity
- prioritize concrete code bloat: generated-looking mass, production-included test/debug/demo artifacts, wrapper swarms, duplicated boilerplate, or manual registries that duplicate a source of truth
- prioritize dead legacy paths kept alive by tests: obsolete validators, schemas, adapters, compatibility branches, feature flags, or helpers
- prioritize cargo-cult defensive code: broad try/catch, fallback, logging, null guard, or "safe" wrapper code that does not match a real trust boundary
- prioritize tautological or coupled tests: tests that mirror implementation internals, repeat giant fake harnesses, or preserve accidental private structure instead of behavior
- prioritize type/build silencing and band-aid hacks: broad disables, any/type-ignore casts, sleeps/timeouts, path mutation, fake success returns, or removed checks when simplification is the fix
- every finding must have a concrete maintenance or runtime cost in the included files
- prefer deletion, consolidation, or existing local patterns over new abstractions
- do not report file size, explicit generated files, normal framework boilerplate, or domain modules that merely look large
- do not report style taste, naming preference, broad architecture opinions, or speculative cleanup
- do not report correctness, security, API contract, data-loss, or build-release issues unless the root cause is accidental complexity and the minimum fix is simplification`;
  }
  throw new Error(`Unsupported review mode: ${mode}`);
}

export async function buildRevalidatePrompt(root: string, findingJson: string): Promise<string> {
  return `Revalidate this clawpatch finding against the current repository at ${root}.

Check whether the original evidence paths/lines still exist. If evidence moved or changed,
decide whether the issue is fixed, stale/false-positive, still open elsewhere, or uncertain.
Use tests and current code as evidence; do not assume a missing line means fixed.

Return strict JSON only:
{"outcome":"fixed|open|false-positive|uncertain","reasoning":"string","commands":["string"]}

Finding:
${findingJson}`;
}

export async function buildFixPrompt(
  root: string,
  finding: FindingRecord,
  feature: FeatureRecord,
  config: ClawpatchConfig,
): Promise<string> {
  const fileBlocks: string[] = [];
  for (const path of fixPromptPaths(finding, feature, config)) {
    fileBlocks.push(await rawFileBlock(root, path));
  }
  return `You are clawpatch applying one small repair in the current repository.

Fix only the finding below. Keep the patch minimal. Add or update focused tests when feasible.
Do not commit, push, switch branches, or run destructive git commands.
After editing, return strict JSON only:
{
  "summary": "string",
  "findingIds": ["string"],
  "plannedFiles": ["string"],
  "risk": "low|medium|high",
  "steps": ["string"],
  "validationCommands": ["string"]
}

Finding:
${JSON.stringify(finding, null, 2)}

Feature:
${JSON.stringify(feature, null, 2)}

Relevant files:
${fileBlocks.join("\n\n")}`;
}

function fixPromptPaths(
  finding: FindingRecord,
  feature: FeatureRecord,
  config: ClawpatchConfig,
): string[] {
  const paths: string[] = [];
  const owned = feature.ownedFiles.slice(0, config.review.maxOwnedFiles);
  const context = feature.contextFiles.slice(0, config.review.maxContextFiles);
  const tests = feature.tests.slice(0, config.review.maxContextFiles);
  const allowed = new Map<string, string>();
  const allowPath = (path: string): void => {
    const normalizedPath = normalizePromptPath(path);
    if (!allowed.has(normalizedPath)) {
      allowed.set(normalizedPath, path);
    }
  };
  for (const ref of feature.ownedFiles) {
    allowPath(ref.path);
  }
  for (const ref of feature.contextFiles) {
    allowPath(ref.path);
  }
  for (const test of feature.tests) {
    allowPath(test.path);
  }
  for (const entrypoint of feature.entrypoints) {
    allowPath(entrypoint.path);
  }
  const push = (path: string): void => {
    if (!paths.includes(path)) {
      paths.push(path);
    }
  };
  for (const evidence of finding.evidence) {
    const allowedPath = allowed.get(normalizePromptPath(evidence.path));
    if (allowedPath !== undefined) {
      push(allowedPath);
    }
  }
  for (const ref of owned) {
    push(ref.path);
  }
  for (const ref of context) {
    push(ref.path);
  }
  for (const test of tests) {
    push(test.path);
  }
  return paths;
}

async function rawFileBlock(root: string, path: string): Promise<string> {
  const full = resolve(root, path);
  if (!isInside(root, full)) {
    return `--- ${path}\n[path escapes repository root]`;
  }
  const realRoot = await realpath(root).catch(() => root);
  const realFull = await realpath(full).catch(() => full);
  if (!isInside(realRoot, realFull)) {
    return `--- ${path}\n[path escapes repository root]`;
  }
  const contents = await readFile(full, "utf8").catch(() => null);
  if (contents === null) {
    return `--- ${path}\n[unreadable]`;
  }
  const truncated = contents.length > REVIEW_PROMPT_FILE_CHAR_LIMIT;
  const trimmed = truncated
    ? `${contents.slice(0, REVIEW_PROMPT_FILE_CHAR_LIMIT)}\n...[truncated]`
    : contents;
  return `--- ${path}\n${trimmed}`;
}

async function fileBlockWithManifest(
  root: string,
  path: string,
  role: ReviewPromptFileRole,
): Promise<{ block: string; manifest: ReviewPromptFileManifest }> {
  const full = resolve(root, path);
  if (!isInside(root, full)) {
    return skippedFileBlock(path, role, "path escapes repository root");
  }
  const realRoot = await realpath(root).catch(() => root);
  const realFull = await realpath(full).catch(() => full);
  if (!isInside(realRoot, realFull)) {
    return skippedFileBlock(path, role, "path escapes repository root");
  }
  const contents = await readFile(full, "utf8").catch(() => null);
  if (contents === null) {
    return {
      block: `--- ${path}\n[unreadable]`,
      manifest: {
        path,
        role,
        bytes: 0,
        includedBytes: 0,
        includedStartLine: null,
        includedEndLine: null,
        includedLineRanges: [],
        truncated: false,
        readable: false,
        skippedReason: "unreadable",
      },
    };
  }
  const bytes = Buffer.byteLength(contents, "utf8");
  const excerpt = prefixExcerpt(contents);
  return {
    block: `--- ${path} (${role}, ${rangeLabel(excerpt.includedLineRanges)}${
      excerpt.truncated ? ", truncated" : ""
    })\n${excerpt.body}`,
    manifest: {
      path,
      role,
      bytes,
      includedBytes: Buffer.byteLength(excerpt.includedContents, "utf8"),
      includedStartLine: excerpt.includedLineRanges[0]?.startLine ?? null,
      includedEndLine: excerpt.includedLineRanges.at(-1)?.endLine ?? null,
      includedLineRanges: excerpt.includedLineRanges,
      truncated: excerpt.truncated,
      readable: true,
      skippedReason: null,
    },
  };
}

function skippedFileBlock(
  path: string,
  role: ReviewPromptFileRole,
  reason: string,
): { block: string; manifest: ReviewPromptFileManifest } {
  return {
    block: `--- ${path}\n[skipped: ${reason}]`,
    manifest: {
      path,
      role,
      bytes: 0,
      includedBytes: 0,
      includedStartLine: null,
      includedEndLine: null,
      includedLineRanges: [],
      truncated: false,
      readable: false,
      skippedReason: reason,
    },
  };
}

function prefixExcerpt(contents: string): {
  body: string;
  includedContents: string;
  includedLineRanges: ReviewPromptLineRange[];
  truncated: boolean;
} {
  const truncated = contents.length > REVIEW_PROMPT_FILE_CHAR_LIMIT;
  const includedContents = truncated ? contents.slice(0, REVIEW_PROMPT_FILE_CHAR_LIMIT) : contents;
  const includedEndLine = reviewLineCount(includedContents);
  const body = `${numberedFileContents(includedContents, 1)}${
    truncated ? `\n...[truncated after line ${includedEndLine}]` : ""
  }`;
  return {
    body,
    includedContents,
    includedLineRanges: [{ startLine: 1, endLine: includedEndLine }],
    truncated,
  };
}

function rangeLabel(ranges: readonly ReviewPromptLineRange[]): string {
  if (ranges.length === 0) {
    return "no lines";
  }
  if (ranges.length === 1) {
    const range = ranges[0]!;
    return `lines ${range.startLine}-${range.endLine}`;
  }
  return `lines ${ranges.map((range) => `${range.startLine}-${range.endLine}`).join(", ")}`;
}

function numberedFileContents(contents: string, startLine: number): string {
  return splitReviewLines(contents)
    .map((line, index) => `${startLine + index} | ${line}`)
    .join("\n");
}

function reviewLineCount(contents: string): number {
  return splitReviewLines(contents).length;
}

function splitReviewLines(contents: string): string[] {
  if (contents.length === 0) {
    return [""];
  }
  const lines = contents.split("\n");
  return contents.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
