import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ClawpatchConfig, FeatureRecord, FindingRecord, ProjectRecord } from "./types.js";

export type ReviewMode = "default" | "deslopify";

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
  const owned = feature.ownedFiles.slice(0, config.review.maxOwnedFiles);
  const context = feature.contextFiles.slice(0, config.review.maxContextFiles);
  const fileBlocks: string[] = [];
  for (const ref of [...owned, ...context]) {
    fileBlocks.push(await fileBlock(root, ref.path));
  }
  const customBlock =
    customPrompt !== null && customPrompt.trim() !== ""
      ? `Additional reviewer guidance (provided via --prompt-file):

${customPrompt.trim()}

`
      : "";
  return `You are reviewing one semantic feature for clawpatch.

Return strict JSON only. No markdown fences.

Project:
${JSON.stringify({ name: project.name, detected: project.detected }, null, 2)}

Feature:
${JSON.stringify(feature, null, 2)}

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

Inspect owned files, context files, and linked tests. Treat included tests as first-class
evidence of intended behavior. If tests contradict a suspected bug, either skip it or
downgrade confidence and explain the uncertainty. Avoid reporting behavior as a bug
solely because a helper name implies a broader contract. Deduplicate sibling/root-cause
issues: when the same bug pattern appears in multiple owned files, emit one finding
with multiple evidence refs instead of separate one-off findings.

Avoid speculative low-evidence findings. Evidence must point at included files.

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
    fileBlocks.push(await fileBlock(root, path));
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
  const allowed = new Set([
    ...feature.ownedFiles.map((ref) => ref.path),
    ...feature.contextFiles.map((ref) => ref.path),
    ...feature.tests.map((test) => test.path),
    ...feature.entrypoints.map((entrypoint) => entrypoint.path),
  ]);
  const push = (path: string): void => {
    if (!paths.includes(path)) {
      paths.push(path);
    }
  };
  for (const evidence of finding.evidence) {
    if (allowed.has(evidence.path)) {
      push(evidence.path);
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

async function fileBlock(root: string, path: string): Promise<string> {
  const full = resolve(root, path);
  if (!isInside(root, full)) {
    return `--- ${path}\n[skipped: path escapes repository root]`;
  }
  const realRoot = await realpath(root).catch(() => root);
  const realFull = await realpath(full).catch(() => full);
  if (!isInside(realRoot, realFull)) {
    return `--- ${path}\n[skipped: path escapes repository root]`;
  }
  const contents = await readFile(full, "utf8").catch(() => "[unreadable]");
  const trimmed =
    contents.length > 24_000 ? `${contents.slice(0, 24_000)}\n...[truncated]` : contents;
  return `--- ${path}\n${trimmed}`;
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
