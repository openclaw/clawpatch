import { runCommandArgs } from "../exec.js";
import { ClawpatchError } from "../errors.js";
import { extractJson, safeProviderPreview } from "../provider-json.js";
import { parseOrThrow, parseReviewOutput } from "../provider-output.js";
import { providerCheckTimeoutMs, providerTimeoutMs } from "../provider-runtime.js";
import {
  agentMapJsonSchema,
  fixPlanJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "../provider-schema.js";
import type { PartitionedReviewOutput, Provider, ProviderOptions } from "../provider-types.js";
import {
  AgentMapOutput,
  FixPlanOutput,
  RevalidateOutput,
  agentMapOutputSchema,
  fixPlanOutputSchema,
  revalidateOutputSchema,
} from "../types.js";

const ACPX_TESTED_VERSIONS = "^0.8.0";
const ACPX_DEFAULT_TIMEOUT_MS = 180_000;

export const acpxProvider: Provider = {
  name: "acpx",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("acpx", ["--version"], root, undefined, {
      timeoutMs: providerCheckTimeoutMs(),
    });
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

function parseAcpxAgent(model: string | null): {
  agent: string;
  agentModel: string | null;
} {
  if (model === null) {
    return { agent: "codex", agentModel: null };
  }
  const index = model.indexOf(":");
  if (index === -1) {
    return { agent: model, agentModel: null };
  }
  return { agent: model.slice(0, index), agentModel: model.slice(index + 1) };
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
  return providerTimeoutMs("CLAWPATCH_ACPX_TIMEOUT_MS", ACPX_DEFAULT_TIMEOUT_MS);
}

function acpxPromptRetries(): number {
  const raw = process.env["CLAWPATCH_ACPX_PROMPT_RETRIES"];
  if (raw === undefined) {
    return 1;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
}

export const acpxTesting = {
  acpxFailureMessage,
  acpxPromptRetries,
  buildAcpxJsonArgs,
  extractAcpxJson,
  parseAcpxJsonOutput,
  parseAcpxAgent,
};
