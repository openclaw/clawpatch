import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandArgs } from "../exec.js";
import { ClawpatchError } from "../errors.js";
import { safeProviderPreview } from "../provider-json.js";
import { parseOrThrow, parseReviewOutput } from "../provider-output.js";
import { providerTimeoutMs } from "../provider-runtime.js";
import {
  agentMapJsonSchema,
  fixPlanJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "../provider-schema.js";
import type { PartitionedReviewOutput, Provider, ProviderOptions } from "../provider-types.js";
import { compareSemanticVersions } from "../provider-version.js";
import {
  AgentMapOutput,
  FixPlanOutput,
  RevalidateOutput,
  agentMapOutputSchema,
  fixPlanOutputSchema,
  revalidateOutputSchema,
  type ReasoningEffort,
} from "../types.js";

const CLAUDE_DEFAULT_TIMEOUT_MS = 180_000;
const CLAUDE_READ_ONLY_TOOLS = "Read,Grep,Glob";
const CLAUDE_WRITE_TOOLS = "default";
const CLAUDE_SAFE_MODE_MIN_VERSION: [number, number, number] = [2, 1, 169];
const CLAUDE_PUBLIC_STRING_ERROR_CODES = new Set(["authentication_failed"]);
const CLAUDE_AUTH_SMOKE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean", const: true } },
  required: ["ok"],
  additionalProperties: false,
} as const;
type ClaudeAuthContext = "isolated" | "host";
const CLAUDE_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_REGION",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
] as const;

export const claudeProvider: Provider = {
  name: "claude",
  async check(root: string): Promise<string> {
    const authContext = claudeAuthContext();
    const result = await runClaudeCommand(["--version"], root, undefined, {
      includeAuth: false,
      authContext,
      timeoutMs: claudeTimeoutMs(),
    });
    if (result.exitCode !== 0) {
      throw new ClawpatchError("claude CLI not available", 4, "provider-auth");
    }
    const version = result.stdout.trim() || result.stderr.trim();
    assertClaudeVersionAllowed(version);
    assertClaudeAuthContextSupported(version, authContext);
    if (authContext === "host") {
      const output = await runClaudeJson(
        root,
        "Return ok=true to confirm this provider invocation is authenticated.",
        { model: null, reasoningEffort: null, skipGitRepoCheck: false },
        CLAUDE_AUTH_SMOKE_SCHEMA,
        true,
      );
      if (
        typeof output !== "object" ||
        output === null ||
        (output as Record<string, unknown>)["ok"] !== true
      ) {
        throw new ClawpatchError(
          "claude provider auth smoke returned an invalid result",
          8,
          "malformed-output",
        );
      }
    }
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
  const authContext = claudeAuthContext();
  const version = await claudeVersion(root, authContext);
  assertClaudeVersionAllowed(version);
  assertClaudeAuthContextSupported(version, authContext);
  const args = claudeArgs(schema, options, readOnly, authContext);
  const result = await runClaudeCommand(args, root, prompt, {
    includeAuth: true,
    authContext,
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

async function claudeVersion(root: string, authContext: ClaudeAuthContext): Promise<string> {
  const result = await runClaudeCommand(["--version"], root, undefined, {
    includeAuth: false,
    authContext,
    timeoutMs: claudeTimeoutMs(),
  });
  if (result.exitCode !== 0) {
    throw new ClawpatchError("claude CLI not available", 4, "provider-auth");
  }
  return result.stdout.trim() || result.stderr.trim();
}

function claudeArgs(
  schema: object,
  options: ProviderOptions,
  readOnly: boolean,
  authContext: ClaudeAuthContext,
): string[] {
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
    authContext === "host" ? "--safe-mode" : "--bare",
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
  options: { includeAuth: boolean; authContext: ClaudeAuthContext; timeoutMs: number },
): Promise<Awaited<ReturnType<typeof runCommandArgs>>> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-claude-"));
  try {
    const env = claudeEnv(options.includeAuth, dir, options.authContext);
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

function claudeEnv(
  includeAuth: boolean,
  baseDir: string,
  authContext: ClaudeAuthContext,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  copyPathEnv(env);
  copyEnv(env, "SystemRoot");
  copyEnv(env, "ComSpec");
  copyEnv(env, "PATHEXT");
  if (authContext === "host") {
    env["HOME"] = process.env["HOME"]?.trim() || homedir();
    copyEnv(env, "USERPROFILE");
    copyEnv(env, "CLAUDE_CONFIG_DIR");
  } else {
    env["HOME"] = join(baseDir, "home");
  }
  env["XDG_CONFIG_HOME"] = join(baseDir, "xdg-config");
  env["XDG_CACHE_HOME"] = join(baseDir, "xdg-cache");
  env["XDG_DATA_HOME"] = join(baseDir, "xdg-data");
  env["TMPDIR"] = baseDir;
  env["TEMP"] = baseDir;
  env["TMP"] = baseDir;
  env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "1";
  if (includeAuth) {
    for (const key of CLAUDE_AUTH_ENV_KEYS) {
      copyEnv(env, key);
    }
    if (
      process.env["AWS_CONFIG_FILE"] !== undefined ||
      process.env["AWS_SHARED_CREDENTIALS_FILE"] !== undefined
    ) {
      copyEnv(env, "AWS_PROFILE");
    }
    if (authContext === "host") {
      copyEnv(env, "CLAUDE_CODE_OAUTH_TOKEN");
    }
  }
  return env;
}

function claudeAuthContext(): ClaudeAuthContext {
  const configured = process.env["CLAWPATCH_CLAUDE_AUTH_CONTEXT"]?.trim().toLowerCase();
  if (configured === undefined || configured.length === 0 || configured === "isolated") {
    return "isolated";
  }
  if (configured === "host") {
    return "host";
  }
  throw new ClawpatchError(
    "CLAWPATCH_CLAUDE_AUTH_CONTEXT must be isolated or host",
    4,
    "provider-auth",
  );
}

function assertClaudeAuthContextSupported(raw: string, authContext: ClaudeAuthContext): void {
  if (authContext !== "host") {
    return;
  }
  const parsed = parseClaudeVersion(raw);
  if (parsed === null || compareSemanticVersions(parsed, CLAUDE_SAFE_MODE_MIN_VERSION) < 0) {
    throw new ClawpatchError(
      "Claude host auth context requires Claude Code 2.1.169 or newer for --safe-mode",
      4,
      "provider-auth",
    );
  }
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
    const trimmed = error.trim();
    return CLAUDE_PUBLIC_STRING_ERROR_CODES.has(trimmed) ? trimmed : null;
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
  const signal = claudeFailureSignal(stdout);
  const combined = `${stderr}\n${signal}`;
  if (
    /auth|login|api key|unauthorized|authentication|oauth|not authenticated|not[- ]logged[- ]in|api_error_status=(?:401|403)\b/iu.test(
      combined,
    )
  ) {
    return claudeFailureWithSignal("claude provider auth/config failed", signal);
  }
  if (/quota|rate.?limit|billing|credit|api_error_status=(?:402|429)\b/iu.test(combined)) {
    return claudeFailureWithSignal("claude provider quota/rate-limit failed", signal);
  }
  return signal.length === 0 ? "claude provider failed" : `claude provider failed: ${signal}`;
}

function claudeFailureWithSignal(message: string, signal: string): string {
  return signal.length === 0 ? message : `${message}: ${signal}`;
}

function claudeExitCode(stdout: string, stderr: string, exitCode: number | null): number {
  const combined = `${stderr}\n${claudeFailureSignal(stdout)}`;
  if (
    /auth|login|api key|unauthorized|authentication|oauth|not authenticated|not[- ]logged[- ]in|api_error_status=(?:401|403)\b/iu.test(
      combined,
    )
  ) {
    return 4;
  }
  if (/quota|rate.?limit|billing|credit|api_error_status=(?:402|429)\b/iu.test(combined)) {
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
    if (record["is_error"] === true) {
      parts.push("is_error=true");
    }
    const result = record["result"];
    if (typeof result === "string" && /not logged in|please run \/login/iu.test(result)) {
      parts.push("reason=not-logged-in");
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
  return [...new Set(parts.filter((part) => part.length > 0))].slice(0, 12).join("; ");
}

function assertClaudeVersionAllowed(raw: string): void {
  const parsed = parseClaudeVersion(raw);
  if (parsed === null) {
    return;
  }
  if (
    compareSemanticVersions(parsed, [2, 1, 53]) < 0 ||
    (compareSemanticVersions(parsed, [2, 1, 63]) >= 0 &&
      compareSemanticVersions(parsed, [2, 1, 84]) < 0)
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

function claudeTimeoutMs(): number {
  return providerTimeoutMs("CLAWPATCH_CLAUDE_TIMEOUT_MS", CLAUDE_DEFAULT_TIMEOUT_MS);
}

export const claudeTesting = {
  addClaudeModelArgs,
  assertClaudeAuthContextSupported,
  assertClaudeVersionAllowed,
  claudeArgs,
  claudeAuthContext,
  claudeEffort,
  claudeEnv,
  claudeExitCode,
  claudeFailureMessage,
  claudeTimeoutMs,
  extractClaudeStructuredOutput,
  parseClaudeVersion,
};
