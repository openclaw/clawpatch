import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type ZodError, type ZodIssue, type ZodType } from "zod";
import { runCommandArgs } from "./exec.js";
import { ClawpatchError } from "./errors.js";
import {
  agentMapJsonSchema,
  fixPlanJsonSchema,
  providerJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "./provider-schema.js";
import { extractJson, parseCodexJson, safeProviderPreview } from "./provider-json.js";
import {
  AgentMapOutput,
  FixPlanOutput,
  ReviewFinding,
  RevalidateOutput,
  agentMapOutputSchema,
  fixPlanOutputSchema,
  reviewFindingSchema,
  reviewInspectedSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
  type ReasoningEffort,
} from "./types.js";

export { extractJson } from "./provider-json.js";

const ZOD_VALUE_PREVIEW_LIMIT = 80;
const ZOD_ISSUE_HEAD_LIMIT = 3;

function formatZodPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) {
    return "<root>";
  }
  let out = "";
  for (let i = 0; i < path.length; i += 1) {
    const segment = path[i];
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (i === 0) {
      out += String(segment);
    } else {
      out += `.${String(segment)}`;
    }
  }
  return out;
}

function previewZodValue(value: unknown): string {
  let rendered: string;
  if (typeof value === "string") {
    rendered = JSON.stringify(value);
  } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
    rendered = String(value);
  } else if (value === undefined) {
    return "";
  } else {
    try {
      rendered = JSON.stringify(value) ?? String(value);
    } catch {
      rendered = String(value);
    }
  }
  if (rendered.length > ZOD_VALUE_PREVIEW_LIMIT) {
    return `${rendered.slice(0, ZOD_VALUE_PREVIEW_LIMIT - 1)}…`;
  }
  return rendered;
}

function lookupAtPath(input: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = input;
  for (const segment of path) {
    if (cur === null || cur === undefined) {
      return undefined;
    }
    if (typeof segment === "number") {
      if (!Array.isArray(cur)) {
        return undefined;
      }
      cur = cur[segment];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[String(segment)];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function formatZodIssue(issue: ZodIssue, input?: unknown): string {
  const path = formatZodPath(issue.path);
  const issueRecord = issue as ZodIssue & {
    received?: unknown;
    expected?: unknown;
    values?: unknown;
  };
  let received: unknown;
  let hasReceived = false;
  if ("received" in issueRecord && issueRecord.received !== undefined) {
    received = issueRecord.received;
    hasReceived = true;
  } else if (input !== undefined && issue.path.length > 0) {
    const looked = lookupAtPath(input, issue.path);
    if (looked !== undefined) {
      received = looked;
      hasReceived = true;
    }
  }
  const receivedSegment = hasReceived ? `=${previewZodValue(received)}` : "";
  let expectedSegment = "";
  if (Array.isArray(issueRecord.values)) {
    const list = issueRecord.values.map((v) => String(v)).join(",");
    expectedSegment = `, expected one of ${list}`;
  } else if (typeof issueRecord.expected === "string" && issueRecord.expected.length > 0) {
    expectedSegment = `, expected ${issueRecord.expected}`;
  }
  return `${path}${receivedSegment} (${issue.code}${expectedSegment})`;
}

export function formatZodError(error: ZodError, input?: unknown): string {
  const issues = error.issues ?? [];
  if (issues.length === 0) {
    return "schema validation failed";
  }
  const head = issues
    .slice(0, ZOD_ISSUE_HEAD_LIMIT)
    .map((issue) => formatZodIssue(issue, input))
    .join("; ");
  const more =
    issues.length > ZOD_ISSUE_HEAD_LIMIT ? ` (+${issues.length - ZOD_ISSUE_HEAD_LIMIT} more)` : "";
  return `schema validation failed: ${head}${more}`;
}

function parseOrThrow<T>(schema: ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new ClawpatchError(
    `${label}: ${formatZodError(result.error, input)}`,
    8,
    "malformed-output",
  );
}

export type ProviderOptions = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  skipGitRepoCheck: boolean;
};

/**
 * One review finding rejected by per-finding validation. `layer` records
 * which gate dropped it: `schema` is the per-finding `reviewFindingSchema`
 * Zod parse, `validation` is the evidence/quote/line-range check in
 * `validateReviewOutputPartitioned`. Operators can use `layer` to tell
 * "the model emitted nonsense for this finding" (schema) apart from
 * "the model cited a real-looking finding but pointed at the wrong file
 * or quoted text that isn't there" (validation).
 */
export type DroppedFinding = {
  path: (string | number)[];
  message: string;
  sample: string;
  layer?: "schema" | "validation";
};

export type PartitionedReviewOutput = {
  findings: ReviewFinding[];
  inspected: z.infer<typeof reviewInspectedSchema>;
  droppedFindings: DroppedFinding[];
};

const reviewContainerSchema = z.object({
  findings: z.array(z.unknown()),
  inspected: reviewInspectedSchema,
});

function truncateSample(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) {
    text = String(value);
  }
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export function parseReviewOutput(output: unknown): PartitionedReviewOutput {
  // Fast path: whole-document parse on success.
  const whole = reviewOutputSchema.safeParse(output);
  if (whole.success) {
    return {
      findings: whole.data.findings,
      inspected: whole.data.inspected,
      droppedFindings: [],
    };
  }

  // Fallback: validate container shape, partition findings element-by-element.
  const container = reviewContainerSchema.safeParse(output);
  if (!container.success) {
    // Container shape is fundamentally wrong (e.g. findings is not an array, or
    // inspected is missing). Preserve today's throw contract via ClawpatchError
    // so callers see a single clear malformed-output failure.
    const issue = container.error.issues[0];
    const where =
      issue?.path
        .map((segment) => (typeof segment === "symbol" ? segment.toString() : segment))
        .join(".") ?? "<root>";
    const detail = issue?.message ?? "invalid review output shape";
    throw new ClawpatchError(
      `provider review output is malformed at ${where}: ${detail}`,
      8,
      "malformed-output",
    );
  }

  const validFindings: ReviewFinding[] = [];
  const droppedFindings: DroppedFinding[] = [];
  container.data.findings.forEach((candidate, idx) => {
    const result = reviewFindingSchema.safeParse(candidate);
    if (result.success) {
      validFindings.push(result.data);
      return;
    }
    const issue = result.error.issues[0];
    const issuePath = (issue?.path ?? []).map((segment) =>
      typeof segment === "symbol" ? segment.toString() : segment,
    );
    droppedFindings.push({
      path: ["findings", idx, ...issuePath],
      message: issue?.message ?? "invalid finding shape",
      sample: truncateSample(candidate),
      layer: "schema",
    });
  });

  return {
    findings: validFindings,
    inspected: container.data.inspected,
    droppedFindings,
  };
}

export type Provider = {
  name: string;
  check(root: string): Promise<string>;
  map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput>;
  review(root: string, prompt: string, options: ProviderOptions): Promise<PartitionedReviewOutput>;
  fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput>;
  revalidate(root: string, prompt: string, options: ProviderOptions): Promise<RevalidateOutput>;
};

export function providerByName(name: string): Provider {
  if (name === "codex") {
    return codexProvider;
  }
  if (name === "opencode") {
    return opencodeProvider;
  }
  if (name === "acpx") {
    return acpxProvider;
  }
  if (name === "grok") {
    return grokProvider;
  }
  if (name === "pi") {
    return piProvider;
  }
  if (name === "claude") {
    return claudeProvider;
  }
  if (name === "mock") {
    return mockProvider;
  }
  if (name === "mock-fail") {
    return mockFailProvider;
  }
  throw new ClawpatchError(`unsupported provider: ${name}`, 2, "unsupported-provider");
}

const codexProvider: Provider = {
  name: "codex",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("codex", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError("codex CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runCodexJson(root, prompt, options, agentMapJsonSchema);
    return parseOrThrow(agentMapOutputSchema, output, "codex agent-map");
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    const output = await runCodexJson(root, prompt, options, reviewJsonSchema);
    return parseReviewOutput(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runCodexJson(root, prompt, options, fixPlanJsonSchema, "workspace-write");
    return parseOrThrow(fixPlanOutputSchema, output, "codex fix-plan");
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runCodexJson(root, prompt, options, revalidateJsonSchema);
    return parseOrThrow(revalidateOutputSchema, output, "codex revalidate");
  },
};

const opencodeProvider: Provider = {
  name: "opencode",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("opencode", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError("opencode CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, agentMapJsonSchema, true);
    return parseOrThrow(agentMapOutputSchema, output, "opencode agent-map");
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, reviewJsonSchema, true);
    return parseReviewOutput(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, fixPlanJsonSchema, false);
    return parseOrThrow(fixPlanOutputSchema, output, "opencode fix-plan");
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, revalidateJsonSchema, true);
    return parseOrThrow(revalidateOutputSchema, output, "opencode revalidate");
  },
};

const ACPX_TESTED_VERSIONS = "^0.8.0";
const ACPX_DEFAULT_TIMEOUT_MS = 180_000;

const acpxProvider: Provider = {
  name: "acpx",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("acpx", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        "acpx CLI not available. Install: npm install -g acpx@latest",
        4,
        "provider-auth",
      );
    }
    const version = result.stdout.trim();
    return `${version} (tested against ${ACPX_TESTED_VERSIONS})`;
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    return runAcpxJson(root, prompt, options.model, agentMapJsonSchema, "read", (output) =>
      parseOrThrow(agentMapOutputSchema, output, "acpx agent-map"),
    );
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    return runAcpxJson(root, prompt, options.model, reviewJsonSchema, "read", (output) =>
      parseReviewOutput(output),
    );
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    return runAcpxJson(root, prompt, options.model, fixPlanJsonSchema, "approve", (output) =>
      parseOrThrow(fixPlanOutputSchema, output, "acpx fix-plan"),
    );
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    return runAcpxJson(root, prompt, options.model, revalidateJsonSchema, "read", (output) =>
      parseOrThrow(revalidateOutputSchema, output, "acpx revalidate"),
    );
  },
};

const grokProvider: Provider = {
  name: "grok",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("grok", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError("grok CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runGrokJson(root, prompt, options.model, agentMapJsonSchema, true);
    return parseOrThrow(agentMapOutputSchema, output, "grok agent-map");
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    const output = await runGrokJson(root, prompt, options.model, reviewJsonSchema, true);
    return parseReviewOutput(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runGrokJson(root, prompt, options.model, fixPlanJsonSchema, false);
    return parseOrThrow(fixPlanOutputSchema, output, "grok fix-plan");
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runGrokJson(root, prompt, options.model, revalidateJsonSchema, true);
    return parseOrThrow(revalidateOutputSchema, output, "grok revalidate");
  },
};

const PI_DEFAULT_TIMEOUT_MS = 180_000;

const piProvider: Provider = {
  name: "pi",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("pi", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError("pi CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim() || result.stderr.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runPiJson(root, prompt, options, agentMapJsonSchema, true);
    return parseOrThrow(agentMapOutputSchema, output, "pi map");
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    const output = await runPiJson(root, prompt, options, reviewJsonSchema, true);
    return parseReviewOutput(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runPiJson(root, prompt, options, fixPlanJsonSchema, false);
    return parseOrThrow(fixPlanOutputSchema, output, "pi fix-plan");
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runPiJson(root, prompt, options, revalidateJsonSchema, true);
    return parseOrThrow(revalidateOutputSchema, output, "pi revalidate");
  },
};

const CLAUDE_DEFAULT_TIMEOUT_MS = 180_000;
const CLAUDE_READ_ONLY_TOOLS = "Read,Grep,Glob";
const CLAUDE_WRITE_TOOLS = "default";

const claudeProvider: Provider = {
  name: "claude",
  async check(root: string): Promise<string> {
    const result = await runClaudeCommand(["--version"], root, undefined, {
      includeAuth: false,
      timeoutMs: claudeTimeoutMs(),
    });
    if (result.exitCode !== 0) {
      throw new ClawpatchError("claude CLI not available", 4, "provider-auth");
    }
    const version = result.stdout.trim() || result.stderr.trim();
    assertClaudeVersionAllowed(version);
    return version;
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runClaudeJson(root, prompt, options, agentMapJsonSchema, true);
    return parseOrThrow(agentMapOutputSchema, output, "claude agent-map");
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    const output = await runClaudeJson(root, prompt, options, reviewJsonSchema, true);
    return parseReviewOutput(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runClaudeJson(root, prompt, options, fixPlanJsonSchema, false);
    return parseOrThrow(fixPlanOutputSchema, output, "claude fix-plan");
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runClaudeJson(root, prompt, options, revalidateJsonSchema, true);
    return parseOrThrow(revalidateOutputSchema, output, "claude revalidate");
  },
};

async function runClaudeJson(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  const version = await claudeVersion(root);
  assertClaudeVersionAllowed(version);
  const args = claudeArgs(schema, options, readOnly);
  const result = await runClaudeCommand(args, root, prompt, {
    includeAuth: true,
    timeoutMs: claudeTimeoutMs(),
  });
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      claudeFailureMessage(result.stdout, result.stderr, result.exitCode),
      claudeExitCode(result.stdout, result.stderr, result.exitCode),
      "provider-failure",
    );
  }
  return extractClaudeStructuredOutput(result.stdout);
}

async function claudeVersion(root: string): Promise<string> {
  const result = await runClaudeCommand(["--version"], root, undefined, {
    includeAuth: false,
    timeoutMs: claudeTimeoutMs(),
  });
  if (result.exitCode !== 0) {
    throw new ClawpatchError("claude CLI not available", 4, "provider-auth");
  }
  return result.stdout.trim() || result.stderr.trim();
}

function claudeArgs(schema: object, options: ProviderOptions, readOnly: boolean): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--tools",
    readOnly ? CLAUDE_READ_ONLY_TOOLS : CLAUDE_WRITE_TOOLS,
    "--permission-mode",
    readOnly ? "dontAsk" : "acceptEdits",
    "--no-session-persistence",
    "--bare",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--disable-slash-commands",
    "--no-chrome",
  ];
  addClaudeModelArgs(args, options);
  return args;
}

function addClaudeModelArgs(args: string[], options: ProviderOptions): void {
  if (options.model !== null) {
    args.push("--model", options.model);
  }
  if (options.reasoningEffort !== null && options.reasoningEffort !== "none") {
    args.push("--effort", claudeEffort(options.reasoningEffort));
  }
}

function claudeEffort(reasoningEffort: ReasoningEffort): string {
  if (reasoningEffort === "minimal") {
    return "low";
  }
  return reasoningEffort;
}

async function runClaudeCommand(
  args: string[],
  root: string,
  input: string | undefined,
  options: { includeAuth: boolean; timeoutMs: number },
): Promise<Awaited<ReturnType<typeof runCommandArgs>>> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-claude-"));
  try {
    const env = claudeEnv(options.includeAuth, dir);
    return await runCommandArgs(claudeExecutable(), args, root, input, {
      trimOutput: false,
      timeoutMs: options.timeoutMs,
      env,
      replaceEnv: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function claudeEnv(includeAuth: boolean, baseDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  copyPathEnv(env);
  copyEnv(env, "SystemRoot");
  copyEnv(env, "ComSpec");
  copyEnv(env, "PATHEXT");
  env["HOME"] = join(baseDir, "home");
  env["XDG_CONFIG_HOME"] = join(baseDir, "xdg-config");
  env["XDG_CACHE_HOME"] = join(baseDir, "xdg-cache");
  env["XDG_DATA_HOME"] = join(baseDir, "xdg-data");
  env["TMPDIR"] = baseDir;
  env["TEMP"] = baseDir;
  env["TMP"] = baseDir;
  if (includeAuth) {
    copyEnv(env, "ANTHROPIC_API_KEY");
  }
  return env;
}

function copyPathEnv(target: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === "path") {
      copyEnv(target, key);
      return;
    }
  }
}

function copyEnv(target: NodeJS.ProcessEnv, key: string): void {
  const value = process.env[key];
  if (value !== undefined && value.length > 0) {
    target[key] = value;
  }
}

function claudeExecutable(): string {
  const configured = process.env["CLAWPATCH_CLAUDE_BIN"]?.trim();
  return configured && configured.length > 0 ? configured : "claude";
}

function extractClaudeStructuredOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (text.length === 0) {
    throw new ClawpatchError("claude provider produced no output", 8, "malformed-output");
  }
  const envelopes = extractJsonObjects(text);
  if (envelopes.length === 0) {
    throw new ClawpatchError("claude provider produced no JSON envelope", 8, "malformed-output");
  }
  for (const envelope of envelopes) {
    const structured = claudeStructuredOutput(envelope);
    if (structured.found) {
      return structured.value;
    }
  }
  throw new ClawpatchError(
    "claude provider JSON envelope is missing structured_output",
    8,
    "malformed-output",
  );
}

function claudeStructuredOutput(value: unknown): { found: boolean; value: unknown } {
  if (typeof value !== "object" || value === null) {
    return { found: false, value: undefined };
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "error")) {
    const message = claudeEnvelopeErrorCode(record["error"]) ?? "provider-error";
    throw new ClawpatchError(
      `claude provider error: ${message}`,
      claudeExitCode("", message, 1),
      "provider-failure",
    );
  }
  if (Object.hasOwn(record, "structured_output")) {
    const output = record["structured_output"];
    if (typeof output !== "object" || output === null) {
      throw new ClawpatchError(
        "claude provider structured_output is not an object",
        8,
        "malformed-output",
      );
    }
    return { found: true, value: output };
  }
  return { found: false, value: undefined };
}

function claudeEnvelopeErrorCode(error: unknown): string | null {
  if (typeof error === "string") {
    return null;
  }
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const record = error as Record<string, unknown>;
  for (const key of ["type", "code"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return safeProviderPreview(value);
    } else if (typeof value === "number") {
      return String(value);
    }
  }
  return null;
}

function extractJsonObjects(text: string): unknown[] {
  const direct = parseJsonObject(text);
  if (direct.found) {
    return [direct.value];
  }
  const outputs: unknown[] = [];
  let firstBrace = text.indexOf("{");
  while (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    let foundEnd = false;
    for (let index = firstBrace; index < text.length; index += 1) {
      const ch = text[index];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(firstBrace, index + 1);
          const parsed = parseJsonObject(candidate);
          if (parsed.found) {
            outputs.push(parsed.value);
          }
          firstBrace = text.indexOf("{", index + 1);
          foundEnd = true;
          break;
        }
      }
    }
    if (!foundEnd) {
      break;
    }
  }
  return outputs;
}

function parseJsonObject(text: string): { found: boolean; value: unknown } {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? { found: true, value: parsed }
      : { found: false, value: undefined };
  } catch {
    return { found: false, value: undefined };
  }
}

function claudeFailureMessage(stdout: string, stderr: string, exitCode: number | null): string {
  if (exitCode === 124 || /timed out/iu.test(stderr)) {
    return "claude provider timed out";
  }
  const combined = `${stderr}\n${claudeFailureSignal(stdout)}`;
  if (/auth|login|api key|unauthorized|authentication|oauth|not authenticated/iu.test(combined)) {
    return "claude provider auth/config failed";
  }
  if (/quota|rate.?limit|billing|credit/iu.test(combined)) {
    return "claude provider quota/rate-limit failed";
  }
  const signal = claudeFailureSignal(stdout);
  return signal.length === 0 ? "claude provider failed" : `claude provider failed: ${signal}`;
}

function claudeExitCode(stdout: string, stderr: string, exitCode: number | null): number {
  const combined = `${stderr}\n${claudeFailureSignal(stdout)}`;
  if (/auth|login|api key|unauthorized|authentication|oauth|not authenticated/iu.test(combined)) {
    return 4;
  }
  if (/quota|rate.?limit|billing|credit/iu.test(combined)) {
    return 5;
  }
  if (exitCode === 124 || /timed out/iu.test(combined)) {
    return 1;
  }
  return 1;
}

function claudeFailureSignal(stdout: string): string {
  const parts: string[] = [];
  for (const envelope of extractJsonObjects(stdout)) {
    if (typeof envelope !== "object" || envelope === null) {
      continue;
    }
    const record = envelope as Record<string, unknown>;
    const errorCode = claudeEnvelopeErrorCode(record["error"]);
    if (errorCode !== null) {
      parts.push(`error=${errorCode}`);
    }
    for (const key of ["type", "subtype", "api_error_status", "terminal_reason"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        parts.push(`${key}=${safeProviderPreview(value, 80)}`);
      } else if (typeof value === "number") {
        parts.push(`${key}=${value}`);
      }
    }
  }
  return parts.filter((part) => part.length > 0).join("; ");
}

function assertClaudeVersionAllowed(raw: string): void {
  const parsed = parseClaudeVersion(raw);
  if (parsed === null) {
    return;
  }
  if (
    compareSemver(parsed, [2, 1, 53]) < 0 ||
    (compareSemver(parsed, [2, 1, 63]) >= 0 && compareSemver(parsed, [2, 1, 84]) < 0)
  ) {
    throw new ClawpatchError(
      `claude CLI version ${parsed.join(".")} is blocked by known security advisories; upgrade Claude Code to 2.1.84 or newer`,
      4,
      "provider-auth",
    );
  }
}

function parseClaudeVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/u);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function claudeTimeoutMs(): number {
  const raw =
    process.env["CLAWPATCH_CLAUDE_TIMEOUT_MS"] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  if (raw === undefined) {
    return CLAUDE_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CLAUDE_DEFAULT_TIMEOUT_MS;
}

async function runPiJson(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-pi-"));
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, piPrompt(prompt, schema, readOnly), "utf8");

  try {
    const args = [
      "-p",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-extensions",
      "--no-prompt-templates",
      "--no-themes",
      `@${promptPath}`,
      "Follow the attached clawpatch prompt. Return only the requested JSON object.",
    ];
    if (options.model !== null) {
      args.push("--model", options.model);
    }
    if (options.reasoningEffort !== null) {
      args.push("--thinking", piThinkingLevel(options.reasoningEffort));
    }
    if (readOnly) {
      args.push("--tools", "read");
    }
    const result = await runCommandArgs("pi", args, root, undefined, {
      trimOutput: false,
      timeoutMs: piTimeoutMs(),
    });
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        piFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stderr),
        "provider-failure",
      );
    }
    const text = result.stdout.trim();
    if (text.length === 0) {
      throw new ClawpatchError("pi provider produced no output", 8, "malformed-output");
    }
    const parsed = extractJson(text);
    if (parsed === null) {
      throw new ClawpatchError(
        `pi provider produced unparsable JSON (output preview: ${safeProviderPreview(text)})`,
        8,
        "malformed-output",
      );
    }
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function piPrompt(prompt: string, schema: object, readOnly: boolean): string {
  const promptBody = readOnly
    ? "READ-ONLY REVIEW MODE.\n" +
      "Do not modify, create, or delete any files.\n" +
      "Do not run shell commands.\n\n" +
      prompt
    : prompt;
  return `${promptBody}\n\nProvider output schema:\n${JSON.stringify(schema, null, 2)}\n\nReturn only one JSON object matching the schema.`;
}

function piFailureMessage(stdout: string, stderr: string): string {
  if (stderr.trim().length > 0) {
    return `pi provider failed: ${safeProviderPreview(stderr)}`;
  }
  const preview = safeProviderPreview(stdout);
  return preview.length === 0
    ? "pi provider failed"
    : `pi provider failed (output preview: ${preview})`;
}

function piThinkingLevel(reasoningEffort: ReasoningEffort): string {
  return reasoningEffort === "none" ? "off" : reasoningEffort;
}

function piTimeoutMs(): number {
  const raw =
    process.env["CLAWPATCH_PI_TIMEOUT_MS"] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  if (raw === undefined) {
    return PI_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PI_DEFAULT_TIMEOUT_MS;
}

const mockProvider: Provider = {
  name: "mock",
  async check(): Promise<string> {
    return "mock";
  },
  async map(_root: string, prompt: string): Promise<AgentMapOutput> {
    const paths = [...prompt.matchAll(/"([^"]*agent\/[^"]+\.[^"]+)"/gu)]
      .map((match) => match[1]?.trim())
      .filter((path): path is string => path !== undefined && path.length > 0);
    const owned = [...new Set(paths.filter((path) => !/test|spec/u.test(path)))].slice(0, 6);
    const tests = paths.filter((path) => /test|spec/u.test(path)).slice(0, 3);
    return {
      features:
        owned.length === 0
          ? []
          : [
              {
                title: "Agent mapped package agent",
                summary: "Mock agent mapper grouped otherwise unmapped agent files.",
                kind: "library",
                confidence: "medium",
                entrypoints: [{ path: owned[0]!, symbol: null, route: null, command: null }],
                ownedFiles: owned.map((path) => ({ path, reason: "agent mapper owned file" })),
                contextFiles: tests.map((path) => ({ path, reason: "agent mapper nearby test" })),
                tests: tests.map((path) => ({ path, command: "touch SHOULD_NOT_RUN_AGENT_MAP" })),
                tags: ["agent-mapped"],
                trustBoundaries: [],
                reason: "Mock provider detected the agent/ source group.",
              },
            ],
      notes: ["mock agent map"],
    };
  },
  async review(_root: string, prompt: string): Promise<PartitionedReviewOutput> {
    if (!prompt.includes("TODO_BUG") && !prompt.includes("BUG:")) {
      return {
        findings: [],
        inspected: { files: [], symbols: [], notes: ["mock clean"] },
        droppedFindings: [],
      };
    }
    const evidencePath = prompt.includes("BAD_EVIDENCE")
      ? "src/not-included.ts"
      : (firstPromptFileWith(prompt, "TODO_BUG") ?? "src/index.ts");
    if (prompt.includes("DESLOPIFY_LATE")) {
      return {
        findings: [
          {
            title: "General bug first",
            category: "bug",
            severity: "medium",
            confidence: "high",
            evidence: [
              {
                path: evidencePath,
                startLine: null,
                endLine: null,
                symbol: null,
                quote: "TODO_BUG",
              },
            ],
            reasoning: "Mock provider found an explicit bug marker.",
            reproduction: null,
            recommendation: "Replace marker with real handling.",
            whyTestsDoNotAlreadyCoverThis:
              "Mock fixtures do not encode this marker as intended behavior.",
            suggestedRegressionTest: "Add a focused test that fails when TODO_BUG is present.",
            minimumFixScope: "Replace the marker in the owning feature file.",
          },
          {
            title: "Late simplification finding",
            category: "maintainability",
            severity: "low",
            confidence: "high",
            evidence: [
              {
                path: evidencePath,
                startLine: null,
                endLine: null,
                symbol: null,
                quote: "DESLOPIFY_LATE",
              },
            ],
            reasoning: "Mock provider returned a simplification finding after a general finding.",
            reproduction: null,
            recommendation: "Keep the deslopify finding after mode filtering.",
            whyTestsDoNotAlreadyCoverThis:
              "Mock fixtures need to prove filtering occurs before the finding cap.",
            suggestedRegressionTest: null,
            minimumFixScope: "Filter before capping.",
          },
        ],
        inspected: { files: [evidencePath], symbols: [], notes: ["mock mixed findings"] },
        droppedFindings: [],
      };
    }
    return {
      findings: [
        {
          title: "Marker bug found",
          category: "bug",
          severity: "medium",
          confidence: "high",
          evidence: [
            {
              path: evidencePath,
              startLine: null,
              endLine: null,
              symbol: null,
              quote: "TODO_BUG",
            },
          ],
          reasoning: "Mock provider found an explicit bug marker.",
          reproduction: null,
          recommendation: "Replace marker with real handling.",
          whyTestsDoNotAlreadyCoverThis:
            "Mock fixtures do not encode this marker as intended behavior.",
          suggestedRegressionTest: "Add a focused test that fails when TODO_BUG is present.",
          minimumFixScope: "Replace the marker in the owning feature file.",
        },
      ],
      inspected: { files: [evidencePath], symbols: [], notes: ["mock finding"] },
      droppedFindings: [],
    };
  },
  async fix(): Promise<FixPlanOutput> {
    return {
      summary: "mock fix plan",
      findingIds: [],
      plannedFiles: [],
      risk: "low",
      steps: ["mock"],
      validationCommands: ["touch SHOULD_NOT_RUN_PROVIDER_COMMANDS"],
    };
  },
  async revalidate(_root: string, prompt: string): Promise<RevalidateOutput> {
    if (prompt.includes("REVALIDATE_FIXED")) {
      return { outcome: "fixed", reasoning: "mock fixed outcome", commands: ["mock fixed"] };
    }
    if (prompt.includes("REVALIDATE_OPEN")) {
      return { outcome: "open", reasoning: "mock open outcome", commands: ["mock open"] };
    }
    if (prompt.includes("REVALIDATE_FALSE_POSITIVE")) {
      return {
        outcome: "false-positive",
        reasoning: "mock false-positive outcome",
        commands: ["mock false-positive"],
      };
    }
    return { outcome: "uncertain", reasoning: "mock provider cannot inspect fixes", commands: [] };
  },
};

function firstPromptFileWith(prompt: string, marker: string): string | null {
  const blocks = prompt.split(/^--- /gmu).slice(1);
  for (const block of blocks) {
    const newline = block.indexOf("\n");
    if (newline === -1) {
      continue;
    }
    const path = block.slice(0, newline).trim();
    const contents = block.slice(newline + 1);
    if (path.length > 0 && contents.includes(marker)) {
      return path;
    }
  }
  return null;
}

const mockFailProvider: Provider = {
  name: "mock-fail",
  async check(): Promise<string> {
    return "mock-fail";
  },
  async map(): Promise<AgentMapOutput> {
    throw new ClawpatchError("mock map failure", 1, "mock-failure");
  },
  async review(): Promise<PartitionedReviewOutput> {
    throw new ClawpatchError("mock review failure", 1, "mock-failure");
  },
  async fix(): Promise<FixPlanOutput> {
    throw new ClawpatchError("mock fix failure", 1, "mock-failure");
  },
  async revalidate(): Promise<RevalidateOutput> {
    throw new ClawpatchError("mock revalidate failure", 1, "mock-failure");
  },
};

async function runCodexJson(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  sandbox = "read-only",
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-codex-"));
  const schemaPath = join(dir, "schema.json");
  const outputPath = join(dir, "output.json");
  await writeFile(schemaPath, JSON.stringify(schema), "utf8");
  try {
    const args = [
      "exec",
      "--cd",
      root,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
    ];
    addCodexSandboxArgs(args, sandbox);
    addCodexModelArgs(args, options);
    args.push("-");
    const result = await runCommandArgs("codex", args, root, prompt);
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        codexFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stderr),
        "provider-failure",
      );
    }
    const raw = await readFile(outputPath, "utf8").catch(() => "");
    if (raw.trim().length === 0) {
      throw new ClawpatchError("codex provider produced no JSON output", 8, "malformed-output");
    }
    return parseCodexJson(raw);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function codexFailureMessage(stdout: string, stderr: string): string {
  const output = stderr || stdout;
  const scopeAdvice = /api\.responses\.write|insufficient permissions|missing scopes/iu.test(output)
    ? "\nCodex/OpenAI auth is missing Responses API write access (`api.responses.write`). Check the active credentials, organization/project role, and restricted key scopes."
    : "";
  return `codex provider failed: ${output}${scopeAdvice}`;
}

function addCodexSandboxArgs(args: string[], sandbox: string): void {
  const override = process.env["CLAWPATCH_CODEX_SANDBOX"]?.trim();
  if (override === "bypass" || override === "none") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
    return;
  }
  args.push("--sandbox", override && override.length > 0 ? override : sandbox);
}

function addCodexModelArgs(args: string[], options: ProviderOptions): void {
  if (options.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (options.model !== null) {
    args.push("--model", options.model);
  }
  if (options.reasoningEffort !== null) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }
}

const OPENCODE_READ_ONLY_PERMISSION = JSON.stringify({
  bash: "deny",
  edit: "deny",
  task: "deny",
  webfetch: "deny",
  websearch: "deny",
});

async function runOpencodeJson(
  root: string,
  prompt: string,
  model: string | null,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-opencode-"));
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, opencodePrompt(prompt, schema, readOnly), "utf8");

  try {
    const args = [
      "run",
      "Follow the attached clawpatch prompt. Return only the requested JSON object.",
      "--format",
      "json",
      "--dir",
      root,
      `--file=${promptPath}`,
    ];
    if (model !== null) {
      args.push("--model", model);
    }
    if (!readOnly) {
      args.push("--dangerously-skip-permissions");
    }
    const result = await runCommandArgs(
      "opencode",
      args,
      root,
      undefined,
      readOnly
        ? { trimOutput: false, env: { OPENCODE_PERMISSION: OPENCODE_READ_ONLY_PERMISSION } }
        : { trimOutput: false },
    );
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        opencodeFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stderr),
        "provider-failure",
      );
    }
    return extractOpencodeJson(result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function opencodePrompt(prompt: string, schema: object, readOnly: boolean): string {
  const promptBody = readOnly
    ? "READ-ONLY REVIEW MODE.\n" +
      "Do not modify, create, or delete any files.\n" +
      "Do not run shell commands or launch subagents.\n\n" +
      prompt
    : prompt;
  return `${promptBody}

Provider output schema:
${JSON.stringify(schema, null, 2)}

Return only one JSON object matching the schema.`;
}

export function extractOpencodeJson(stdout: string): unknown {
  const textParts: string[] = [];
  const observedKinds = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let event: {
      type?: string;
      part?: { text?: unknown };
      error?: { data?: { message?: unknown }; name?: unknown; message?: unknown };
    };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }
    if (typeof event.type === "string") {
      observedKinds.add(event.type);
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      textParts.push(event.part.text);
    }
    if (event.type === "error") {
      const message =
        typeof event.error?.data?.message === "string"
          ? event.error.data.message
          : typeof event.error?.message === "string"
            ? event.error.message
            : typeof event.error?.name === "string"
              ? event.error.name
              : "unknown";
      throw new ClawpatchError(
        `opencode provider error: ${message}`,
        providerExitCode(message),
        "provider-failure",
      );
    }
  }
  const combined = textParts.join("").trim();
  if (combined.length === 0) {
    throw new ClawpatchError(
      `opencode provider produced no extractable text. Observed event kinds: ` +
        `[${[...observedKinds].join(", ")}].`,
      8,
      "malformed-output",
    );
  }
  const parsed = extractJson(combined);
  if (parsed === null) {
    throw new ClawpatchError(
      `opencode provider produced unparsable JSON ` +
        `(text chars=${combined.length}, observed event kinds: ` +
        `[${[...observedKinds].join(", ")}], output preview: ${safeProviderPreview(combined)})`,
      8,
      "malformed-output",
    );
  }
  return parsed;
}

function opencodeFailureMessage(stdout: string, stderr: string): string {
  if (stderr.trim().length > 0) {
    return `opencode provider failed: ${stderr}`;
  }
  const preview = stdout.slice(0, 800).replace(/\s+/gu, " ");
  return preview.length === 0
    ? "opencode provider failed"
    : `opencode provider failed (stdout preview: ${preview})`;
}

export function parseAcpxAgent(model: string | null): {
  agent: string;
  agentModel: string | null;
} {
  if (model === null) {
    return { agent: "codex", agentModel: null };
  }
  const idx = model.indexOf(":");
  if (idx === -1) {
    return { agent: model, agentModel: null };
  }
  return { agent: model.slice(0, idx), agentModel: model.slice(idx + 1) };
}

function buildAcpxJsonArgs(
  root: string,
  model: string | null,
  permission: "read" | "approve",
): string[] {
  const { agent, agentModel } = parseAcpxAgent(model);
  const permFlag = permission === "read" ? "--approve-reads" : "--approve-all";
  const args = ["--cwd", root, permFlag, "--format", "json", "--json-strict", "--suppress-reads"];
  const promptRetries = acpxPromptRetries();
  if (permission === "read" && promptRetries > 0) {
    args.push("--prompt-retries", String(promptRetries));
  }
  if (agentModel !== null) {
    args.push("--model", agentModel);
  }
  args.push(agent, "exec", "--file", "-");
  return args;
}

async function runAcpxJson<T>(
  root: string,
  prompt: string,
  model: string | null,
  schema: object,
  permission: "read" | "approve",
  parseOutput: (output: unknown) => T,
): Promise<T> {
  const args = buildAcpxJsonArgs(root, model, permission);
  const result = await runCommandArgs(
    "acpx",
    args,
    root,
    buildAcpxPrompt(prompt, schema, permission),
    { trimOutput: false, timeoutMs: acpxTimeoutMs() },
  );
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      acpxFailureMessage(result.stdout, result.stderr, result.exitCode),
      acpxExitCode(result.stdout, result.stderr, result.exitCode),
      "provider-failure",
    );
  }
  return parseAcpxJsonOutput(result.stdout, parseOutput);
}

function buildAcpxPrompt(prompt: string, schema: object, permission: "read" | "approve"): string {
  const promptBody =
    permission === "read"
      ? "READ-ONLY REVIEW MODE.\n" +
        "Do not modify, create, or delete any files.\n" +
        "Do not make any tool calls that write to the workspace.\n" +
        "Only read files and report findings in the JSON output below.\n\n" +
        prompt
      : prompt;

  return (
    `${promptBody}\n\n` +
    "Return ONLY a JSON object matching this schema. No prose preamble, no markdown fences, " +
    "no thinking-out-loud text before the JSON. " +
    `Schema:\n${JSON.stringify(schema)}\n`
  );
}

export function extractAcpxJson(stdout: string): unknown {
  const { candidates, observedKinds } = acpxJsonCandidates(stdout, false);
  return parseAcpxJsonCandidates(candidates, observedKinds, (output) => output);
}

function parseAcpxJsonOutput<T>(stdout: string, parseOutput: (output: unknown) => T): T {
  const { candidates, observedKinds } = acpxJsonCandidates(stdout, true);
  return parseAcpxJsonCandidates(candidates, observedKinds, parseOutput);
}

function acpxJsonCandidates(
  stdout: string,
  retrySafe: boolean,
): { candidates: string[]; observedKinds: Set<string> } {
  const toolCandidates: string[] = [];
  const messageChunks: string[] = [];
  const thoughtChunks: string[] = [];
  const observedKinds = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let env: {
      method?: string;
      params?: {
        update?: {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
          output?: unknown;
        };
      };
    };
    try {
      env = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (env.method !== "session/update") {
      continue;
    }
    const update = env.params?.update;
    if (update?.sessionUpdate === undefined) {
      continue;
    }
    observedKinds.add(update.sessionUpdate);
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      messageChunks.push(update.content.text);
    } else if (
      update.sessionUpdate === "agent_thought_chunk" &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      thoughtChunks.push(update.content.text);
    } else if (update.sessionUpdate === "tool_call_result" && typeof update.output === "string") {
      toolCandidates.push(update.output);
    }
  }
  const candidates = retrySafe
    ? [
        ...chunkSuffixCandidates(messageChunks),
        ...toolCandidates.toReversed(),
        ...chunkSuffixCandidates(thoughtChunks),
      ]
    : [
        ...(messageChunks.length > 0 ? [messageChunks.join("")] : []),
        ...toolCandidates.toReversed(),
        ...(thoughtChunks.length > 0 ? [thoughtChunks.join("")] : []),
      ];
  return { candidates, observedKinds };
}

function parseAcpxJsonCandidates<T>(
  candidates: string[],
  observedKinds: Set<string>,
  parseOutput: (output: unknown) => T,
): T {
  if (candidates.length === 0) {
    throw new ClawpatchError(
      `acpx provider produced no extractable text. Observed envelope kinds: ` +
        `[${[...observedKinds].join(", ")}]. ` +
        `acpx envelope shape may have changed since clawpatch was tested ` +
        `against ${ACPX_TESTED_VERSIONS}. Check the installed acpx version.`,
      8,
      "malformed-output",
    );
  }

  let lastErr: unknown;
  for (const candidate of candidates) {
    const text = candidate.trim();
    try {
      const parsed = extractJson(text);
      if (parsed !== null) {
        return parseOutput(parsed);
      }
      throw new Error("no JSON object found");
    } catch (err) {
      lastErr = err;
    }
  }
  throw new ClawpatchError(
    `acpx provider produced unparseable JSON: ${(lastErr as Error).message}. ` +
      `Observed envelope kinds: [${[...observedKinds].join(", ")}]. ` +
      `acpx envelope shape may have changed since clawpatch was tested ` +
      `against ${ACPX_TESTED_VERSIONS}. Check the installed acpx version.`,
    8,
    "malformed-output",
  );
}

function chunkSuffixCandidates(chunks: string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  let suffix = "";
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    suffix = `${chunks[index] ?? ""}${suffix}`;
    const candidate = suffix.trim();
    if (candidate.length > 0 && !seen.has(candidate)) {
      candidates.push(candidate);
      seen.add(candidate);
    }
  }
  return candidates;
}

async function runGrokJson(
  root: string,
  prompt: string,
  model: string | null,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-grok-"));
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, grokPrompt(prompt, schema), "utf8");

  try {
    const args = [
      "--prompt-file",
      promptPath,
      "--output-format",
      "json",
      "--always-approve",
      "--verbatim",
      "--cwd",
      root,
    ];
    if (model !== null) {
      args.push("-m", model);
    }
    if (readOnly) {
      args.push("--disallowed-tools", "search_replace,run_terminal_cmd,Agent");
    }
    const result = await runCommandArgs("grok", args, root, undefined, { trimOutput: false });
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        `grok provider failed: ${result.stderr || result.stdout}`,
        providerExitCode(result.stderr),
        "provider-failure",
      );
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(result.stdout) as unknown;
    } catch {
      const preview = result.stdout.slice(0, 200).replace(/\s+/gu, " ");
      throw new ClawpatchError(
        `grok provider produced no JSON envelope (stdout preview: ${preview})`,
        8,
        "malformed-output",
      );
    }
    const text = grokEnvelopeText(envelope);
    const parsed = text === null ? envelope : extractJson(text);
    if (parsed === null) {
      throw new ClawpatchError("grok provider produced unparsable JSON", 8, "malformed-output");
    }
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function grokPrompt(prompt: string, schema: object): string {
  return `${prompt}

Provider output schema:
${JSON.stringify(schema, null, 2)}

Return only one JSON object matching the schema.`;
}

function grokEnvelopeText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  for (const key of ["text", "response", "output", "content"]) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === "string") {
      return item;
    }
  }
  const choices = (value as Record<string, unknown>)["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0] as unknown;
    if (typeof first === "object" && first !== null) {
      const message = (first as Record<string, unknown>)["message"];
      if (typeof message === "object" && message !== null) {
        const content = (message as Record<string, unknown>)["content"];
        if (typeof content === "string") {
          return content;
        }
      }
    }
  }
  return null;
}

function providerExitCode(stderr: string): number {
  if (/auth|login|api key|unauthorized|wrong api key/iu.test(stderr)) {
    return 4;
  }
  if (/quota|rate.?limit/iu.test(stderr)) {
    return 5;
  }
  return 1;
}

function acpxFailureMessage(stdout: string, stderr: string, exitCode: number | null): string {
  const error = extractAcpxError(stdout);
  if (error !== null) {
    return `acpx provider failed: ${error}`;
  }
  const stderrPreview = safeProviderPreview(stderr);
  if (stderrPreview.length > 0) {
    return `acpx provider failed: ${stderrPreview}`;
  }
  return `acpx provider failed with exit code ${exitCode ?? "unknown"}`;
}

function extractAcpxError(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let env: unknown;
    try {
      env = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (typeof env !== "object" || env === null) {
      continue;
    }
    const error = (env as Record<string, unknown>)["error"];
    if (typeof error !== "object" || error === null) {
      continue;
    }
    const errorRecord = error as Record<string, unknown>;
    const data = errorRecord["data"];
    const dataRecord =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const parts = [
      stringPart("code", errorRecord["code"]),
      stringPart("acpxCode", dataRecord["acpxCode"]),
      stringPart("detail", dataRecord["detailCode"]),
      stringPart("origin", dataRecord["origin"]),
      stringPart("message", errorRecord["message"], 160),
    ].filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts.join("; ");
    }
  }
  return null;
}

function stringPart(label: string, value: unknown, maxLength = 80): string {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }
  const preview = safeProviderPreview(String(value), maxLength);
  return preview.length === 0 ? "" : `${label}=${preview}`;
}

function acpxExitCode(stdout: string, stderr: string, exitCode: number | null): number {
  const combined = `${stderr}\n${extractAcpxError(stdout) ?? ""}`;
  if (/auth|login|api key|not authenticated|AUTH_REQUIRED/iu.test(combined)) {
    return 4;
  }
  if (/quota|rate.?limit/iu.test(combined)) {
    return 5;
  }
  if (/acpx: command not found|spawn acpx ENOENT/iu.test(combined)) {
    return 4;
  }
  if (exitCode === 3 || exitCode === 124 || /TIMEOUT|timed out/iu.test(combined)) {
    return 1;
  }
  return 1;
}

function acpxTimeoutMs(): number {
  const raw =
    process.env["CLAWPATCH_ACPX_TIMEOUT_MS"] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  if (raw === undefined) {
    return ACPX_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ACPX_DEFAULT_TIMEOUT_MS;
}

function acpxPromptRetries(): number {
  const raw = process.env["CLAWPATCH_ACPX_PROMPT_RETRIES"];
  if (raw === undefined) {
    return 1;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
}

// eslint-disable-next-line no-underscore-dangle
export const __testing = {
  acpxFailureMessage,
  acpxPromptRetries,
  addCodexModelArgs,
  addCodexSandboxArgs,
  addClaudeModelArgs,
  assertClaudeVersionAllowed,
  buildAcpxJsonArgs,
  claudeArgs,
  claudeEffort,
  claudeEnv,
  claudeExitCode,
  claudeFailureMessage,
  claudeTimeoutMs,
  codexFailureMessage,
  extractAcpxJson,
  extractClaudeStructuredOutput,
  parseAcpxJsonOutput,
  extractOpencodeJson,
  parseClaudeVersion,
  formatZodError,
  formatZodIssue,
  parseAcpxAgent,
  parseCodexJson,
  parseReviewOutput,
  parseOrThrow,
  piThinkingLevel,
  providerJsonSchema,
};
