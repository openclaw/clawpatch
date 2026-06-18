import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandArgs } from "./exec.js";
import { ClawpatchError } from "./errors.js";
import { parseOrThrow, parseReviewOutput } from "./provider-output.js";
import {
  agentMapJsonSchema,
  fixPlanJsonSchema,
  providerJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "./provider-schema.js";
import { extractJson, parseCodexJson, safeProviderPreview } from "./provider-json.js";
import { providerExitCode } from "./provider-errors.js";
import type { PartitionedReviewOutput, Provider, ProviderOptions } from "./provider-types.js";
import { claudeProvider, claudeTesting } from "./providers/claude.js";
import { cursorProvider, cursorTesting } from "./providers/cursor.js";
import { grokProvider } from "./providers/grok.js";
import { mockFailProvider, mockProvider } from "./providers/mock.js";
import { piProvider, piTesting } from "./providers/pi.js";
import {
  AgentMapOutput,
  FixPlanOutput,
  RevalidateOutput,
  agentMapOutputSchema,
  fixPlanOutputSchema,
  revalidateOutputSchema,
  type CodexConfig,
} from "./types.js";

export { extractJson } from "./provider-json.js";

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
  if (name === "cursor") {
    return cursorProvider;
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

const CODEX_DEFAULT_TIMEOUT_MS = 300_000;

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
    const result = await runCommandArgs("codex", args, root, prompt, {
      timeoutMs: codexTimeoutMs(),
    });
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        codexFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stdout, result.stderr),
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

function codexTimeoutMs(): number {
  const raw =
    process.env["CLAWPATCH_CODEX_TIMEOUT_MS"] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  if (raw === undefined) {
    return CODEX_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CODEX_DEFAULT_TIMEOUT_MS;
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
  addCodexConfigArgs(args, options.codexConfig ?? {});
  if (options.model !== null) {
    args.push("--model", options.model);
  }
  if (options.reasoningEffort !== null) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }
}

const CODEX_CONFIG_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;

function addCodexConfigArgs(args: string[], config: CodexConfig): void {
  for (const [key, value] of Object.entries(config).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    args.push("-c", renderCodexConfigEntry(key, value));
  }
}

function renderCodexConfigEntry(key: string, value: CodexConfig[string]): string {
  if (!CODEX_CONFIG_KEY.test(key)) {
    throw new ClawpatchError(`invalid Codex config key: ${key}`, 2, "invalid-usage");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ClawpatchError(
      `invalid Codex config value for ${key}: finite number required`,
      2,
      "invalid-usage",
    );
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ClawpatchError(`invalid Codex config value for ${key}`, 2, "invalid-usage");
  }
  return `${key}=${encoded}`;
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
        providerExitCode(result.stdout, result.stderr),
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
        providerExitCode("", message),
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

// Map acpx promptResult.stopReason -> ClawpatchError code/exit pair.
// `end_turn` is the only successful reason; everything else surfaces as a
// typed error so callers can distinguish cancellation / refusal / truncation
// from an actual envelope-shape regression.
//
// Source: acpx/src/runtime/engine/manager.ts emits the terminal JSON-RPC
// response `{"jsonrpc":"2.0","id":N,"result":{"stopReason":<reason>,...}}`
// for every `session/prompt`. Known reasons in acpx 0.8.0 / claude-agent-acp
// 0.31.4 are `end_turn | cancelled | refusal | max_tokens | max_turn_requests`
// (plus the older `max_turns_exceeded` spelling seen in agent-driven turn loops).
const ACPX_STOP_REASON_CODES: Record<string, string> = {
  cancelled: "agent-cancelled",
  refusal: "agent-refused",
  max_tokens: "agent-truncated",
  max_turn_requests: "agent-truncated",
  max_turns_exceeded: "agent-truncated",
};
const ACPX_STOP_EXIT_CODES: Record<string, number> = {
  cancelled: 1,
  refusal: 1,
  max_tokens: 8,
  max_turn_requests: 8,
  max_turns_exceeded: 8,
};

export function extractAcpxJson(stdout: string): unknown {
  const { candidates, observedKinds, terminalStopReason } = acpxJsonCandidates(stdout, false);
  return parseAcpxJsonCandidates(candidates, observedKinds, terminalStopReason, (output) => output);
}

function parseAcpxJsonOutput<T>(stdout: string, parseOutput: (output: unknown) => T): T {
  const { candidates, observedKinds, terminalStopReason } = acpxJsonCandidates(stdout, true);
  return parseAcpxJsonCandidates(candidates, observedKinds, terminalStopReason, parseOutput);
}

function acpxJsonCandidates(
  stdout: string,
  retrySafe: boolean,
): { candidates: string[]; observedKinds: Set<string>; terminalStopReason: string | undefined } {
  const toolCandidates: string[] = [];
  const messageChunks: string[] = [];
  const thoughtChunks: string[] = [];
  const observedKinds = new Set<string>();
  // Last-seen terminal JSON-RPC response envelope: `{id, result: {stopReason, ...}}`.
  // acpx emits exactly one per `session/prompt` turn (see
  // acpx/src/runtime/engine/manager.ts). If this is anything other than
  // "end_turn" the agent is telling us the turn produced no answer, and we
  // should surface a typed error instead of trying to parse chunks.
  let terminalStopReason: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let env: {
      method?: string;
      id?: unknown;
      result?: { stopReason?: unknown };
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
    if (
      env !== null &&
      typeof env === "object" &&
      Object.prototype.hasOwnProperty.call(env, "id") &&
      env.result !== undefined &&
      env.result !== null &&
      typeof env.result === "object" &&
      typeof env.result.stopReason === "string"
    ) {
      terminalStopReason = env.result.stopReason;
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
  return { candidates, observedKinds, terminalStopReason };
}

function parseAcpxJsonCandidates<T>(
  candidates: string[],
  observedKinds: Set<string>,
  terminalStopReason: string | undefined,
  parseOutput: (output: unknown) => T,
): T {
  if (terminalStopReason !== undefined && terminalStopReason !== "end_turn") {
    const code = ACPX_STOP_REASON_CODES[terminalStopReason] ?? "agent-cancelled";
    const exit = ACPX_STOP_EXIT_CODES[terminalStopReason] ?? 8;
    throw new ClawpatchError(
      `acpx prompt did not complete: stopReason="${terminalStopReason}". ` +
        `Observed envelope kinds: [${[...observedKinds].join(", ")}].`,
      exit,
      code,
    );
  }

  if (candidates.length === 0) {
    const stopReasonNote =
      terminalStopReason === "end_turn"
        ? `acpx reported stopReason=end_turn but emitted no message chunks. ` +
          `This is a clawpatch parser bug or a prompt that produced only tool calls. `
        : ``;
    throw new ClawpatchError(
      `acpx provider produced no extractable text. ${stopReasonNote}` +
        `Observed envelope kinds: [${[...observedKinds].join(", ")}]. ` +
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
  ...claudeTesting,
  ...cursorTesting,
  ...piTesting,
  acpxFailureMessage,
  acpxPromptRetries,
  addCodexConfigArgs,
  addCodexModelArgs,
  addCodexSandboxArgs,
  buildAcpxJsonArgs,
  codexFailureMessage,
  codexTimeoutMs,
  extractAcpxJson,
  parseAcpxJsonOutput,
  extractOpencodeJson,
  parseAcpxAgent,
  parseCodexJson,
  providerExitCode,
  providerJsonSchema,
};
