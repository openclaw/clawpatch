import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { ClawpatchError } from "../errors.js";
import { extractJson, safeProviderPreview } from "../provider-json.js";
import { parseOrThrow, parseReviewOutput } from "../provider-output.js";
import { providerTimeoutMs } from "../provider-runtime.js";
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
  type ReasoningEffort,
} from "../types.js";

const GATEWAY_DEFAULT_BASE_URL = "https://api.proto-labs.ai/v1";
const GATEWAY_DEFAULT_MODEL = "protolabs/smart";
const GATEWAY_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// Newest failure captures kept per diagnostics dir; older ones are pruned.
const GATEWAY_FAILURE_CAPTURE_LIMIT = 20;
// Characters of an unparseable reply's tail quoted in the error.
const GATEWAY_ERROR_TAIL_CHARS = 60;

type GatewayConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  timeoutMs: number;
  maxTokens: number | null;
};

function gatewayConfig(options: ProviderOptions): GatewayConfig {
  const apiKey = process.env["GATEWAY_API_KEY"] ?? process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new ClawpatchError(
      "gateway provider needs GATEWAY_API_KEY or OPENAI_API_KEY in the environment",
      4,
      "provider-auth",
    );
  }
  const rawBase = process.env["OPENAI_BASE_URL"] ?? GATEWAY_DEFAULT_BASE_URL;
  const baseUrl = rawBase.replace(/\/+$/, "");
  const model = options.model ?? process.env["CLAWPATCH_GATEWAY_MODEL"] ?? GATEWAY_DEFAULT_MODEL;
  const timeoutMs = providerTimeoutMs("CLAWPATCH_GATEWAY_TIMEOUT_MS", GATEWAY_DEFAULT_TIMEOUT_MS);
  return {
    apiKey,
    baseUrl,
    model,
    reasoningEffort: options.reasoningEffort,
    timeoutMs,
    maxTokens: gatewayMaxTokens(),
  };
}

// Opt-in output budget. Unset by default on purpose: a fixed default can make
// a large prompt overflow the model's context window (prompt + max_tokens >
// window) and turn a working review into an HTTP 400.
// Invalid CLAWPATCH_GATEWAY_MAX_TOKENS values already warned about (once each).
const warnedGatewayMaxTokens = new Set<string>();

function gatewayMaxTokens(): number | null {
  const raw = process.env["CLAWPATCH_GATEWAY_MAX_TOKENS"];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  // A typo must not silently drop the budget the operator asked for.
  if (!warnedGatewayMaxTokens.has(raw)) {
    warnedGatewayMaxTokens.add(raw);
    process.stderr.write(
      `warning: ignoring CLAWPATCH_GATEWAY_MAX_TOKENS=${JSON.stringify(raw)} ` +
        "(expected a positive integer); no max_tokens is sent\n",
    );
  }
  return null;
}

function gatewayRequestBody(
  prompt: string,
  config: GatewayConfig,
  schema: object,
  label: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: label.replace(/\s+/g, "_"),
        strict: true,
        schema,
      },
    },
  };
  if (config.reasoningEffort && config.reasoningEffort !== "none") {
    body["reasoning_effort"] = config.reasoningEffort;
  }
  if (config.maxTokens !== null) {
    body["max_tokens"] = config.maxTokens;
  }
  return body;
}

type GatewayMessage = {
  content?: unknown;
  // vLLM / LiteLLM put separated reasoning here, depending on version.
  reasoning_content?: unknown;
  reasoning?: unknown;
};

type GatewayPayload = {
  choices?: Array<{ finish_reason?: unknown; message?: GatewayMessage }>;
  error?: { message?: unknown };
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  } | null;
};

async function runGatewayJson(
  prompt: string,
  options: ProviderOptions,
  schema: object,
  label: string,
): Promise<unknown> {
  const config = gatewayConfig(options);
  const body = gatewayRequestBody(prompt, config, schema, label);

  // CLAWPATCH_GATEWAY_TIMEOUT_MS bounds the whole call, retries included. A
  // caller that sizes its own budget from it — pr-reviewer SIGKILLs clawpatch
  // 30 s past it — must never be overrun because a retry got a fresh timeout.
  const attemptStartedAt = Date.now();
  const deadline = (options.callStartedAt ?? attemptStartedAt) + config.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - attemptStartedAt));
  let response: Response;
  let rawBody: string;
  try {
    response = await gatewayFetch(
      `${config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          ...(options.sessionId ? { "x-litellm-session-id": options.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
      config.timeoutMs,
    );
    // Read the body as text, inside the timeout window: a failed reply is
    // captured verbatim, and a body that is not JSON is a typed failure
    // rather than a stray SyntaxError.
    rawBody = await response.text();
  } catch (err) {
    const aborted = controller.signal.aborted;
    const msg = aborted
      ? gatewayTimeoutMessage(Math.max(0, deadline - attemptStartedAt), config.timeoutMs)
      : fetchErrorMessage(err);
    throw new ClawpatchError(`gateway ${label}: request failed (${msg})`, 4, "provider-failure", {
      deadlineExceeded: aborted,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ClawpatchError(
      `gateway ${label}: HTTP ${response.status} ${response.statusText} — ${rawBody.slice(0, 500)}`,
      4,
      "provider-failure",
    );
  }

  try {
    return parseGatewayResponse(rawBody, label, config.maxTokens);
  } catch (error: unknown) {
    if (!(error instanceof ClawpatchError)) {
      throw error;
    }
    const attemptMs = Date.now() - attemptStartedAt;
    const retryable =
      error.retryable === true && gatewayRetryFits(options, attemptStartedAt, config.timeoutMs);
    const capturePath = await captureGatewayFailure(options.diagnosticsDir, {
      label,
      error: error.message,
      model: config.model,
      baseUrl: config.baseUrl,
      reasoningEffort: config.reasoningEffort,
      maxTokens: config.maxTokens,
      promptChars: prompt.length,
      httpStatus: response.status,
      attemptMs,
      rawBody,
    });
    const message =
      capturePath === null ? error.message : withCapturePath(error.message, label, capturePath);
    throw new ClawpatchError(message, error.exitCode, error.code, { retryable });
  }
}

// A retry is worth starting only when the time left under the call's shared
// deadline covers another attempt as long as the one that just failed (on a
// first attempt: it used at most half the timeout). Otherwise the retry would
// be cut off, and its timeout would bury the failure that prompted it.
function gatewayRetryFits(
  options: ProviderOptions,
  attemptStartedAt: number,
  timeoutMs: number,
): boolean {
  const now = Date.now();
  const deadline = (options.callStartedAt ?? attemptStartedAt) + timeoutMs;
  return deadline - now >= now - attemptStartedAt;
}

// States the budget the attempt actually had: a retry only gets what is left
// of the call's shared deadline.
// Node's built-in fetch runs on undici's default Agent, whose headersTimeout and
// bodyTimeout are 300 s. A non-streaming completion that takes longer than that
// to return headers was killed at 300 s as a bare "fetch failed", before the
// CLAWPATCH_GATEWAY_TIMEOUT_MS deadline below ever fired — so raising the
// timeout past 300 s did nothing. The gateway call therefore goes through
// undici's own fetch with an Agent whose timeouts match the deadline; the
// AbortController stays the one clock that ends a call. (undici's fetch, not
// the built-in one with a `dispatcher`: an npm undici Agent handed to Node 22's
// bundled undici 6 fetch fails every request with "invalid onRequestStart
// method".)
const builtinFetch = globalThis.fetch;
const gatewayAgents = new Map<number, Agent>();

function gatewayAgent(timeoutMs: number): Agent {
  let agent = gatewayAgents.get(timeoutMs);
  if (agent === undefined) {
    agent = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    gatewayAgents.set(timeoutMs, agent);
  }
  return agent;
}

type GatewayRequest = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};

function gatewayFetch(url: string, init: GatewayRequest, timeoutMs: number): Promise<Response> {
  // A replaced global fetch (a test stub, an embedder's shim) is honoured as-is.
  if (globalThis.fetch !== builtinFetch) {
    return globalThis.fetch(url, init);
  }
  return undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    dispatcher: gatewayAgent(timeoutMs),
  }) as unknown as Promise<Response>;
}

// undici reports every transport failure as `TypeError: fetch failed` and puts
// the reason (headers timeout, socket closed, connection refused, TLS) on
// `cause` — keep it, or every failure reads the same.
function fetchErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return `${err.message}: ${typeof code === "string" ? `${code} ` : ""}${cause.message}`;
  }
  return err.message;
}

function gatewayTimeoutMessage(budgetMs: number, timeoutMs: number): string {
  return budgetMs < timeoutMs
    ? `no reply within the ${budgetMs}ms left of the ${timeoutMs}ms gateway timeout`
    : `no reply within the ${timeoutMs}ms gateway timeout`;
}

// The saved-file path goes first and the failure class plus its facts last:
// callers that keep only the tail of stderr (pr-reviewer keeps 400 chars)
// must still see what failed, however long the state-dir path is.
function withCapturePath(message: string, label: string, capturePath: string): string {
  const prefix = `gateway ${label}: `;
  const detail = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return `${prefix}full response saved to ${capturePath} — ${detail}`;
}

// Turn a 2xx chat-completions body into the model's JSON answer, or throw a
// provider-failure that says *why* the reply is unusable. Empty, unparseable
// and non-JSON replies are marked retryable (sampling differs per attempt);
// a reply cut off at the output limit is not, because the same prompt
// against the same cap is cut off again.
function parseGatewayResponse(rawBody: string, label: string, maxTokens: number | null): unknown {
  let payload: GatewayPayload;
  try {
    payload = JSON.parse(rawBody) as GatewayPayload;
  } catch {
    throw new ClawpatchError(
      `gateway ${label}: response body was not JSON (preview=${safeProviderPreview(rawBody)})`,
      4,
      "provider-failure",
      { retryable: true },
    );
  }
  if (payload === null || typeof payload !== "object") {
    throw new ClawpatchError(
      `gateway ${label}: response body was not a JSON object (preview=${safeProviderPreview(rawBody)})`,
      4,
      "provider-failure",
      { retryable: true },
    );
  }
  const apiError = payload.error?.message;
  if (typeof apiError === "string" && apiError.length > 0) {
    throw new ClawpatchError(`gateway ${label}: API error — ${apiError}`, 4, "provider-failure");
  }
  const choice = payload.choices?.[0];
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  const message = choice?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  if (content.trim().length > 0) {
    const extracted = extractJson(content);
    if (extracted !== null) {
      // A complete answer is kept even when finish_reason says "length".
      return extracted;
    }
  }
  const facts = gatewayReplyFacts(payload, message, finishReason, content, maxTokens);
  if (finishReason === "length") {
    // No content excerpt here: callers such as pr-reviewer keep only the last
    // ~400 chars of stderr, and the failure class must survive that window.
    // The saved full response has the whole reply.
    throw new ClawpatchError(
      `gateway ${label}: response truncated at the output limit (${facts})`,
      4,
      "provider-failure",
    );
  }
  if (content.trim().length === 0) {
    throw new ClawpatchError(
      `gateway ${label}: empty choices[0].message.content in response (${facts})`,
      4,
      "provider-failure",
      { retryable: true },
    );
  }
  // The tail shows where the JSON broke; the head is always `{"findings":[`.
  const tail = gatewayContentTail(content);
  throw new ClawpatchError(
    `gateway ${label}: response was not parseable JSON (${facts}; tail=${tail ?? ""})`,
    4,
    "provider-failure",
    { retryable: true },
  );
}

// The numbers that separate the failure modes: finish_reason=length with a
// big completion_tokens is a length cap; a large reasoning_tokens share means
// reasoning ate the budget; finish_reason=stop on broken JSON means the
// backend is not enforcing the schema.
function gatewayReplyFacts(
  payload: GatewayPayload,
  message: GatewayMessage | undefined,
  finishReason: string | null,
  content: string,
  maxTokens: number | null,
): string {
  const facts = [`finish_reason=${finishReason ?? "missing"}`];
  const usage = payload.usage ?? undefined;
  const completionTokens = finiteNumber(usage?.completion_tokens);
  if (completionTokens !== null) {
    facts.push(`completion_tokens=${completionTokens}`);
  }
  const reasoningTokens = finiteNumber(usage?.completion_tokens_details?.reasoning_tokens);
  if (reasoningTokens !== null) {
    facts.push(`reasoning_tokens=${reasoningTokens}`);
  }
  const promptTokens = finiteNumber(usage?.prompt_tokens);
  if (promptTokens !== null) {
    facts.push(`prompt_tokens=${promptTokens}`);
  }
  facts.push(`max_tokens=${maxTokens ?? "unset"}`);
  facts.push(`content_chars=${content.length}`);
  const reasoningText = message?.reasoning_content ?? message?.reasoning;
  if (typeof reasoningText === "string" && reasoningText.length > 0) {
    facts.push(`reasoning_chars=${reasoningText.length}`);
  }
  return facts.join(", ");
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function gatewayContentTail(content: string): string | null {
  const collapsed = content.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  return collapsed.length <= GATEWAY_ERROR_TAIL_CHARS
    ? collapsed
    : `…${collapsed.slice(-GATEWAY_ERROR_TAIL_CHARS)}`;
}

// Best-effort: write the full failed reply where the next failure can be
// diagnosed from. Never throws — a capture problem must not mask the
// provider failure it is describing. Returns the file path, or null.
async function captureGatewayFailure(
  dir: string | null | undefined,
  record: { label: string } & Record<string, unknown>,
): Promise<string | null> {
  if (dir === null || dir === undefined || dir.length === 0) {
    return null;
  }
  try {
    await mkdir(dir, { recursive: true });
    const capturedAt = new Date().toISOString();
    // 2026-09-15T06:00:00.123Z -> 20260915T060000123Z (sorts chronologically)
    const stamp = capturedAt.replace(/[-:.]/gu, "");
    const label = record.label.replace(/[^A-Za-z0-9-]+/gu, "-");
    const path = join(dir, `${stamp}-gateway-${label}-${randomUUID().slice(0, 8)}.json`);
    await writeFile(path, `${JSON.stringify({ capturedAt, ...record }, null, 2)}\n`, "utf8");
    await pruneGatewayFailureCaptures(dir);
    return path;
  } catch {
    return null;
  }
}

async function pruneGatewayFailureCaptures(dir: string): Promise<void> {
  const captures = (await readdir(dir))
    .filter((name) => name.includes("-gateway-") && name.endsWith(".json"))
    .toSorted();
  const excess = captures.length - GATEWAY_FAILURE_CAPTURE_LIMIT;
  if (excess <= 0) {
    return;
  }
  await Promise.all(captures.slice(0, excess).map((name) => rm(join(dir, name), { force: true })));
}

export const gatewayProvider: Provider = {
  name: "gateway",
  async check(): Promise<string> {
    // Auth check only — no actual fetch. Avoids spending tokens on a probe.
    // gatewayConfig() throws ClawpatchError with code "provider-auth" if env
    // is missing, which the caller's `clawpatch doctor` flow surfaces as the
    // expected pre-flight failure.
    const { baseUrl, model } = gatewayConfig({
      model: null,
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    return `gateway model=${model} base=${baseUrl}`;
  },
  async map(_root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runGatewayJson(prompt, options, agentMapJsonSchema, "agent-map");
    return parseOrThrow(agentMapOutputSchema, output, "gateway agent-map");
  },
  async review(
    _root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    const attemptStartedAt = Date.now();
    const output = await runGatewayJson(prompt, options, reviewJsonSchema, "review");
    try {
      return parseReviewOutput(output);
    } catch (error: unknown) {
      // A reply of the wrong shape (malformed-output) is retried by its code;
      // hold it to the same rule as an unusable reply, so a retry that cannot
      // fit the time left never buries it under a timeout.
      if (
        error instanceof ClawpatchError &&
        !gatewayRetryFits(options, attemptStartedAt, gatewayConfig(options).timeoutMs)
      ) {
        throw new ClawpatchError(error.message, error.exitCode, error.code, { retryable: false });
      }
      throw error;
    }
  },
  async fix(_root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runGatewayJson(prompt, options, fixPlanJsonSchema, "fix-plan");
    return parseOrThrow(fixPlanOutputSchema, output, "gateway fix-plan");
  },
  async revalidate(
    _root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runGatewayJson(prompt, options, revalidateJsonSchema, "revalidate");
    return parseOrThrow(revalidateOutputSchema, output, "gateway revalidate");
  },
};

export const gatewayTesting = { gatewayConfig };
