import { afterEach, describe, expect, it } from "vitest";
import { ClawpatchError } from "./errors.js";
import { __testing, extractJson, providerByName } from "./provider.js";
import { safeProviderPreview } from "./provider-json.js";
import { agentMapJsonSchema, reviewJsonSchema } from "./provider-schema.js";
import { revalidateOutputSchema, reviewOutputSchema } from "./types.js";

// eslint-disable-next-line no-underscore-dangle
const {
  addCodexSandboxArgs,
  addCodexModelArgs,
  acpxFailureMessage,
  assertCursorRuntimeVersionAllowed,
  codexFailureMessage,
  cursorAgentArgs,
  cursorEnv,
  cursorFailureMessage,
  cursorPrompt,
  cursorTimeoutMs,
  extractAcpxJson,
  extractCursorJson,
  extractOpencodeJson,
  parseAcpxAgent,
  parseCodexJson,
  parseSemver,
  piThinkingLevel,
  providerJsonSchema,
} = __testing;

function updateEnvelope(update: object): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "session-1", update },
  });
}

function textChunk(
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
): string {
  return updateEnvelope({
    sessionUpdate,
    content: { type: "text", text },
  });
}

function toolResult(output: string): string {
  return updateEnvelope({
    sessionUpdate: "tool_call_result",
    output,
  });
}

function expectMalformed(fn: () => unknown, message: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ClawpatchError);
    expect((err as ClawpatchError).code).toBe("malformed-output");
    expect((err as ClawpatchError).exitCode).toBe(8);
    expect((err as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected malformed-output");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

describe("extractJson", () => {
  it("parses strict JSON directly", () => {
    const input = '{"findings":[],"inspected":{"files":[],"symbols":[],"notes":[]}}';
    expect(extractJson(input)).toEqual({
      findings: [],
      inspected: { files: [], symbols: [], notes: [] },
    });
  });

  it("extracts JSON from json code fence", () => {
    const input =
      'Here is the result:\n\n```json\n{"outcome":"fixed","reasoning":"all good","commands":[]}\n```';
    expect(extractJson(input)).toEqual({ outcome: "fixed", reasoning: "all good", commands: [] });
  });

  it("extracts JSON from generic code fence", () => {
    const input = '```\n{"risk":"low","steps":[]}\n```';
    expect(extractJson(input)).toEqual({ risk: "low", steps: [] });
  });

  it("recovers JSON via balanced brace heuristic", () => {
    const input = 'Some leading text { "title": "x", "nested": { "a": 1 } } trailing';
    expect(extractJson(input)).toEqual({ title: "x", nested: { a: 1 } });
  });

  it("skips malformed brace candidates before valid JSON", () => {
    const input = 'thinking { not-json } final {"outcome":"fixed","reasoning":"ok","commands":[]}';

    expect(extractJson(input)).toEqual({
      outcome: "fixed",
      reasoning: "ok",
      commands: [],
    });
  });

  it("does not parse nested JSON from malformed preambles", () => {
    const input =
      'draft { outer: {"outcome":"draft","reasoning":"x","commands":[]} } final ' +
      '{"outcome":"fixed","reasoning":"ok","commands":[]}';

    expect(extractJson(input)).toEqual({
      outcome: "fixed",
      reasoning: "ok",
      commands: [],
    });
  });

  it("returns null for text with no valid JSON", () => {
    expect(extractJson("no json here at all")).toBeNull();
    expect(extractJson("just some words { unbalanced")).toBeNull();
  });
});

describe("parseCodexJson", () => {
  it("accepts codex output-last-message JSON wrapped in markdown with trailing prose", () => {
    const input = [
      "```json",
      '{"findings":[],"inspected":{"files":[],"symbols":[],"notes":[]}}',
      "```",
      "Now I have a complete picture.",
    ].join("\n");

    expect(parseCodexJson(input)).toEqual({
      findings: [],
      inspected: { files: [], symbols: [], notes: [] },
    });
  });

  it("throws malformed-output when codex output contains no JSON object", () => {
    expectMalformed(() => parseCodexJson("not json"), /codex provider produced unparseable JSON/u);
  });
});

describe("Codex provider args", () => {
  const originalCodexSandbox = process.env["CLAWPATCH_CODEX_SANDBOX"];

  afterEach(() => {
    if (originalCodexSandbox === undefined) {
      delete process.env["CLAWPATCH_CODEX_SANDBOX"];
    } else {
      process.env["CLAWPATCH_CODEX_SANDBOX"] = originalCodexSandbox;
    }
  });

  it("uses the requested Codex sandbox by default", () => {
    delete process.env["CLAWPATCH_CODEX_SANDBOX"];
    const args = ["exec"];

    addCodexSandboxArgs(args, "read-only");

    expect(args).toEqual(["exec", "--sandbox", "read-only"]);
  });

  it("allows Codex sandbox mode to be overridden by environment", () => {
    process.env["CLAWPATCH_CODEX_SANDBOX"] = " danger-full-access ";
    const args = ["exec"];

    addCodexSandboxArgs(args, "read-only");

    expect(args).toEqual(["exec", "--sandbox", "danger-full-access"]);
  });

  it("ignores blank Codex sandbox overrides", () => {
    process.env["CLAWPATCH_CODEX_SANDBOX"] = " ";
    const args = ["exec"];

    addCodexSandboxArgs(args, "read-only");

    expect(args).toEqual(["exec", "--sandbox", "read-only"]);
  });

  it("can bypass Codex sandboxing when the host already provides isolation", () => {
    process.env["CLAWPATCH_CODEX_SANDBOX"] = " none ";
    const args = ["exec"];

    addCodexSandboxArgs(args, "read-only");

    expect(args).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  it("passes model and reasoning effort through explicit CLI config", () => {
    const args = ["exec"];

    addCodexModelArgs(args, {
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      skipGitRepoCheck: false,
    });

    expect(args).toEqual(["exec", "--model", "gpt-5.5", "-c", 'model_reasoning_effort="xhigh"']);
  });

  it("passes the Git repo check bypass to Codex when requested", () => {
    const args = ["exec"];

    addCodexModelArgs(args, { model: null, reasoningEffort: null, skipGitRepoCheck: true });

    expect(args).toEqual(["exec", "--skip-git-repo-check"]);
  });

  it("leaves Codex defaults untouched when unset", () => {
    const args = ["exec"];

    addCodexModelArgs(args, { model: null, reasoningEffort: null, skipGitRepoCheck: false });

    expect(args).toEqual(["exec"]);
  });
});

describe("providerJsonSchema", () => {
  it("strips numeric constraints that Codex strict schemas reject", () => {
    const schema = providerJsonSchema(reviewOutputSchema);

    expect(schemaKeys(schema)).not.toEqual(
      expect.arrayContaining([
        "$schema",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minimum",
        "maximum",
        "multipleOf",
      ]),
    );
  });

  it("keeps enum properties typed for Codex strict schemas", () => {
    for (const schema of [
      providerJsonSchema(reviewOutputSchema),
      providerJsonSchema(revalidateOutputSchema),
    ]) {
      const enumNodes = enumSchemaNodes(schema);

      expect(enumNodes.length).toBeGreaterThan(0);
      expect(enumNodes.every((node) => node["type"] === "string")).toBe(true);
    }
  });
});

describe("piThinkingLevel", () => {
  it("maps clawpatch none to pi off", () => {
    expect(piThinkingLevel("none")).toBe("off");
  });

  it("passes supported pi thinking levels through", () => {
    expect(piThinkingLevel("xhigh")).toBe("xhigh");
  });
});

describe("Cursor provider", () => {
  const originalCursorTimeout = process.env["CLAWPATCH_CURSOR_TIMEOUT_MS"];
  const originalProviderTimeout = process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];

  afterEach(() => {
    if (originalCursorTimeout === undefined) {
      delete process.env["CLAWPATCH_CURSOR_TIMEOUT_MS"];
    } else {
      process.env["CLAWPATCH_CURSOR_TIMEOUT_MS"] = originalCursorTimeout;
    }
    if (originalProviderTimeout === undefined) {
      delete process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
    } else {
      process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"] = originalProviderTimeout;
    }
  });

  it("builds the verified trusted read-only print JSON command shape", () => {
    const args = cursorAgentArgs(
      "/repo",
      {
        model: "cursor-model",
        reasoningEffort: "xhigh",
        skipGitRepoCheck: true,
      },
      true,
    );

    expect(args).toEqual([
      "--trust",
      "-p",
      "--output-format",
      "json",
      "--workspace",
      "/repo",
      "--mode",
      "ask",
      "--model",
      "cursor-model",
    ]);
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--yolo");
  });

  it("leaves write-mode Cursor execution ungated by read-only mode flags", () => {
    const args = cursorAgentArgs(
      "/repo",
      {
        model: null,
        reasoningEffort: null,
        skipGitRepoCheck: false,
      },
      false,
    );

    expect(args).toEqual(["--trust", "-p", "--output-format", "json", "--workspace", "/repo"]);
  });

  it("keeps Cursor provider execution disabled by default", async () => {
    const originalExperimental = process.env["CLAWPATCH_CURSOR_EXPERIMENTAL"];
    delete process.env["CLAWPATCH_CURSOR_EXPERIMENTAL"];
    try {
      await expect(
        providerByName("cursor").review("/repo", "prompt", {
          model: null,
          reasoningEffort: null,
          skipGitRepoCheck: false,
        }),
      ).rejects.toThrow(/experimental and disabled by default/u);
    } finally {
      if (originalExperimental === undefined) {
        delete process.env["CLAWPATCH_CURSOR_EXPERIMENTAL"];
      } else {
        process.env["CLAWPATCH_CURSOR_EXPERIMENTAL"] = originalExperimental;
      }
    }
  });

  it("extracts Clawpatch JSON from the Cursor success envelope result", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '```json\n{"findings":[],"inspected":{"files":[],"symbols":[],"notes":[]}}\n```',
    });

    expect(extractCursorJson(stdout)).toEqual({
      findings: [],
      inspected: { files: [], symbols: [], notes: [] },
    });
  });

  it("accepts Cursor success envelopes without a subtype", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      result: '{"outcome":"fixed","reasoning":"ok","commands":[]}',
    });

    expect(extractCursorJson(stdout)).toEqual({
      outcome: "fixed",
      reasoning: "ok",
      commands: [],
    });
  });

  it("rejects Cursor error envelopes", () => {
    expect(() =>
      extractCursorJson(
        JSON.stringify({
          type: "result",
          subtype: "error",
          is_error: true,
          result: "auth required",
        }),
      ),
    ).toThrow(/cursor provider returned an error envelope/u);
  });

  it("rejects missing result text", () => {
    expectMalformed(
      () =>
        extractCursorJson(JSON.stringify({ type: "result", subtype: "success", is_error: false })),
      /missing result text/u,
    );
  });

  it("does not preview malformed Cursor result text", () => {
    const secretPrompt = "SOURCE_CONTEXT_SECRET";

    expect(() =>
      extractCursorJson(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: `not json ${secretPrompt}`,
        }),
      ),
    ).toThrow(/result chars=\d+/u);
    expect(() =>
      extractCursorJson(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: `not json ${secretPrompt}`,
        }),
      ),
    ).not.toThrow(secretPrompt);
  });

  it("rejects multiple Cursor JSON envelopes", () => {
    const stdout = [
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{}" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{}" }),
    ].join("\n");

    expectMalformed(() => extractCursorJson(stdout), /produced 2 JSON envelopes/u);
  });

  it("does not preview stdout unless it looks like auth or quota output", () => {
    const secretPrompt = "SOURCE_CONTEXT_SECRET";

    expect(cursorFailureMessage(secretPrompt, "", 1)).not.toContain(secretPrompt);
    expect(cursorFailureMessage("login required", "", 1)).toContain("authentication required");
  });

  it("does not preview Cursor stderr on failure", () => {
    const secretPrompt = "SOURCE_CONTEXT_SECRET";

    expect(cursorFailureMessage("", secretPrompt, 1)).not.toContain(secretPrompt);
  });

  it("sets Cursor headless browser suppression without replacing the host environment", () => {
    const previous = process.env["CURSOR_API_KEY"];
    try {
      delete process.env["CURSOR_API_KEY"];
      expect(cursorEnv()).toEqual({
        NO_OPEN_BROWSER: "1",
      });
    } finally {
      if (previous === undefined) {
        delete process.env["CURSOR_API_KEY"];
      } else {
        process.env["CURSOR_API_KEY"] = previous;
      }
    }
  });

  it("passes CURSOR_API_KEY through the explicit Cursor env overlay when present", () => {
    const previous = process.env["CURSOR_API_KEY"];
    try {
      process.env["CURSOR_API_KEY"] = "cursor_test_key";
      expect(cursorEnv()).toEqual({
        NO_OPEN_BROWSER: "1",
        CURSOR_API_KEY: "cursor_test_key",
      });
    } finally {
      if (previous === undefined) {
        delete process.env["CURSOR_API_KEY"];
      } else {
        process.env["CURSOR_API_KEY"] = previous;
      }
    }
  });

  it("uses a 300 second default timeout for Cursor", () => {
    delete process.env["CLAWPATCH_CURSOR_TIMEOUT_MS"];
    delete process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];

    expect(cursorTimeoutMs()).toBe(300_000);
  });

  it("adds Cursor-specific strict evidence guidance for reviews", () => {
    const prompt = cursorPrompt("base review prompt", reviewJsonSchema, true);

    expect(prompt).toContain("Cursor evidence rules:");
    expect(prompt).toContain("Always set evidence.quote to null");
    expect(prompt).toContain("evidence.path must exactly match an included file path");
    expect(prompt).toContain("Do not use files outside the prompt excerpts as evidence");
  });

  it("does not add review evidence guidance to Cursor map prompts", () => {
    const prompt = cursorPrompt("base map prompt", agentMapJsonSchema, true);

    expect(prompt).not.toContain("Cursor evidence rules:");
  });

  it("parses semver for Cursor advisory checks", () => {
    expect(parseSemver("2.4.9")).toEqual([2, 4, 9]);
    expect(parseSemver("v2.5")).toEqual([2, 5, 0]);
    expect(parseSemver("2026.05.16-0338208")).toBeNull();
    expect(parseSemver("2.5.0-beta")).toBeNull();
    expect(parseSemver("2.5beta")).toBeNull();
  });

  it("uses Cursor app version for date-formatted CLI builds", () => {
    expect(() => assertCursorRuntimeVersionAllowed("2026.05.16-0338208", "3.2.16")).not.toThrow();
    expect(() => assertCursorRuntimeVersionAllowed("2026.05.16-0338208", "2.4.9")).toThrow(
      /blocked vulnerable Cursor version/u,
    );
  });

  it("does not treat date-formatted CLI builds as advisory proof by themselves", () => {
    expect(() => assertCursorRuntimeVersionAllowed("2026.05.16-0338208", null)).toThrow(
      /could not verify Cursor app\/runtime version/u,
    );
  });

  it("does not treat date-formatted app builds as advisory proof", () => {
    expect(() =>
      assertCursorRuntimeVersionAllowed("2026.05.16-0338208", "2026.05.16-0338208"),
    ).toThrow(/could not verify Cursor app\/runtime version/u);
  });
});

function schemaKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(schemaKeys);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => [key, ...schemaKeys(item)]);
}

function enumSchemaNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(enumSchemaNodes);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const node = value as Record<string, unknown>;
  const nested = Object.values(node).flatMap(enumSchemaNodes);
  return Array.isArray(node["enum"]) ? [node, ...nested] : nested;
}

describe("codexFailureMessage", () => {
  it("adds scope guidance for missing Responses API write permission", () => {
    const message = codexFailureMessage(
      "",
      "401 Unauthorized: Missing scopes: api.responses.write.",
    );

    expect(message).toContain("codex provider failed");
    expect(message).toContain("api.responses.write");
    expect(message).toContain("restricted key scopes");
  });
});

describe("parseAcpxAgent", () => {
  it("defaults null model to codex/null", () => {
    expect(parseAcpxAgent(null)).toEqual({ agent: "codex", agentModel: null });
  });

  it("maps a bare agent name to agent/null", () => {
    expect(parseAcpxAgent("claude")).toEqual({ agent: "claude", agentModel: null });
  });

  it("splits agent and model on a single colon", () => {
    expect(parseAcpxAgent("claude:sonnet-4-5")).toEqual({
      agent: "claude",
      agentModel: "sonnet-4-5",
    });
  });

  it("splits on the first colon so model ids may contain colons", () => {
    expect(parseAcpxAgent("ollama:llama3:70b")).toEqual({
      agent: "ollama",
      agentModel: "llama3:70b",
    });
  });
});

describe("extractAcpxJson", () => {
  it("reconstructs JSON from agent_message_chunk stream", () => {
    const stdout = [
      textChunk("agent_message_chunk", '{"findings":'),
      textChunk("agent_message_chunk", '[],"inspected":{"files":[],"symbols":[],"notes":[]}}'),
    ].join("\n");

    expect(extractAcpxJson(stdout)).toEqual({
      findings: [],
      inspected: { files: [], symbols: [], notes: [] },
    });
  });

  it("reconstructs JSON from agent_thought_chunk stream", () => {
    const stdout = [
      textChunk("agent_thought_chunk", '{"outcome":"fixed",'),
      textChunk("agent_thought_chunk", '"reasoning":"ok","commands":[]}'),
    ].join("\n");

    expect(extractAcpxJson(stdout)).toEqual({
      outcome: "fixed",
      reasoning: "ok",
      commands: [],
    });
  });

  it("reads tool_call_result output when chunks are absent", () => {
    const stdout = toolResult(
      '{"summary":"plan","findingIds":[],"plannedFiles":[],"risk":"low","steps":[],"validationCommands":[]}',
    );

    expect(extractAcpxJson(stdout)).toEqual({
      summary: "plan",
      findingIds: [],
      plannedFiles: [],
      risk: "low",
      steps: [],
      validationCommands: [],
    });
  });

  it("prefers final message chunks over thought chunks", () => {
    const stdout = [
      textChunk("agent_thought_chunk", '{"note":"not final"}'),
      textChunk("agent_message_chunk", '{"ok":true}'),
    ].join("\n");

    expect(extractAcpxJson(stdout)).toEqual({ ok: true });
  });

  it("strips json markdown fences", () => {
    const stdout = textChunk("agent_message_chunk", '```json\n{"ok":true}\n```');

    expect(extractAcpxJson(stdout)).toEqual({ ok: true });
  });

  it("tolerates a prose preamble before the JSON object", () => {
    const stdout = textChunk("agent_message_chunk", 'Here is the JSON:\n{"ok":true}');

    expect(extractAcpxJson(stdout)).toEqual({ ok: true });
  });

  it("throws malformed-output with observed envelope kinds when nothing is extractable", () => {
    const stdout = updateEnvelope({
      sessionUpdate: "usage_update",
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    expectMalformed(() => extractAcpxJson(stdout), /no extractable text.*usage_update.*\^0\.8\.0/u);
  });

  it("throws malformed-output on unparseable concatenation", () => {
    const stdout = [
      textChunk("agent_message_chunk", '{"ok":'),
      textChunk("agent_message_chunk", "not-json}"),
    ].join("\n");

    expectMalformed(() => extractAcpxJson(stdout), /unparseable JSON/u);
  });

  it("ignores initialize, session/new, and result envelopes", () => {
    const stdout = [
      JSON.stringify({ jsonrpc: "2.0", method: "initialize", result: { output: '{"bad":true}' } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/new", result: { output: '{"bad":true}' } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { output: '{"bad":true}' } }),
      textChunk("agent_message_chunk", '{"ok":true}'),
    ].join("\n");

    expect(extractAcpxJson(stdout)).toEqual({ ok: true });
  });

  it("survives a 256-line NDJSON fixture over 8KB", () => {
    const filler = Array.from({ length: 255 }, (_, idx) =>
      updateEnvelope({
        sessionUpdate: "usage_update",
        usage: {
          inputTokens: idx,
          outputTokens: idx + 1,
          note: "x".repeat(80),
        },
      }),
    );
    const lines = [...filler, textChunk("agent_message_chunk", '{"large":true}')];
    const stdout = lines.join("\n");

    expect(lines).toHaveLength(256);
    expect(stdout.length).toBeGreaterThan(8_000);
    expect(extractAcpxJson(stdout)).toEqual({ large: true });
  });
});

describe("acpxFailureMessage", () => {
  it("does not include raw prompt envelopes from ACPX stdout", () => {
    const secretPrompt = "SOURCE_CONTEXT_SECRET";
    const stdout = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: {
          prompt: [{ type: "text", text: secretPrompt }],
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32070,
          message: "Timed out after 500ms",
          data: { acpxCode: "TIMEOUT", origin: "cli", sessionId: "session-1" },
        },
      }),
    ].join("\n");

    const message = acpxFailureMessage(stdout, "", 3);

    expect(message).toContain("acpx provider failed");
    expect(message).toContain("acpxCode=TIMEOUT");
    expect(message).toContain("message=Timed out after 500ms");
    expect(message).not.toContain(secretPrompt);
    expect(message).not.toContain("session/prompt");
  });
});

describe("extractOpencodeJson", () => {
  it("reconstructs JSON from opencode text events", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        part: { text: '{"findings":[],' },
      }),
      JSON.stringify({
        type: "text",
        part: { text: '"inspected":{"files":[],"symbols":[],"notes":[]}}' },
      }),
    ].join("\n");

    expect(extractOpencodeJson(stdout)).toEqual({
      findings: [],
      inspected: { files: [], symbols: [], notes: [] },
    });
  });

  it("extracts fenced JSON from opencode text events", () => {
    const stdout = JSON.stringify({
      type: "text",
      part: { text: '```json\n{"outcome":"fixed","reasoning":"ok","commands":[]}\n```' },
    });

    expect(extractOpencodeJson(stdout)).toEqual({
      outcome: "fixed",
      reasoning: "ok",
      commands: [],
    });
  });

  it("throws malformed-output with observed event kinds when text is absent", () => {
    const stdout = JSON.stringify({ type: "step_finish", part: { reason: "stop" } });

    expectMalformed(() => extractOpencodeJson(stdout), /no extractable text.*step_finish/u);
  });

  it("treats whitespace-only opencode text as no extractable text", () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: " \n\t " } }),
      JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
    ].join("\n");

    expectMalformed(() => extractOpencodeJson(stdout), /no extractable text.*text, step_finish/u);
  });

  it("throws malformed-output with a preview when opencode text is unparsable", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        part: { text: '{"findings": [' },
      }),
      JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
    ].join("\n");

    expectMalformed(
      () => extractOpencodeJson(stdout),
      /unparsable JSON.*text chars=14.*observed event kinds: \[text, step_finish\].*output preview: \{"findings": \[/u,
    );
  });

  it("bounds the opencode unparsable text preview", () => {
    const text = `{"findings":["${"x".repeat(300)}`;
    const stdout = JSON.stringify({
      type: "text",
      part: { text },
    });
    const preview = safeProviderPreview(text);

    expect(preview.length).toBe(200);

    expectMalformed(
      () => extractOpencodeJson(stdout),
      new RegExp(`output preview: ${escapeRegExp(preview)}\\)`, "u"),
    );
  });

  it("throws provider-failure for opencode error events", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: { data: { message: "auth required" } },
    });

    expect(() => extractOpencodeJson(stdout)).toThrow(/auth required/u);
  });

  it("classifies opencode unauthorized errors as provider auth failures", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: { data: { message: "Unauthorized: Wrong API Key" } },
    });

    try {
      extractOpencodeJson(stdout);
    } catch (err) {
      expect(err).toBeInstanceOf(ClawpatchError);
      expect((err as ClawpatchError).exitCode).toBe(4);
      return;
    }
    throw new Error("expected provider auth failure");
  });
});

describe("providerByName", () => {
  it("returns provider instances for optional CLI-backed providers", () => {
    expect(providerByName("acpx").name).toBe("acpx");
    expect(providerByName("grok").name).toBe("grok");
    expect(providerByName("opencode").name).toBe("opencode");
    expect(providerByName("pi").name).toBe("pi");
    expect(providerByName("cursor").name).toBe("cursor");
  });

  it("still supports codex, mock, and mock-fail", () => {
    expect(providerByName("codex").name).toBe("codex");
    expect(providerByName("mock").name).toBe("mock");
    expect(providerByName("mock-fail").name).toBe("mock-fail");
  });
});
