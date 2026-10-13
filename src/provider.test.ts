import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClawpatchError } from "./errors.js";
import { providerTesting, extractJson, providerByName } from "./provider.js";
import { safeProviderPreview } from "./provider-json.js";
import { agentMapJsonSchema, reviewJsonSchema } from "./provider-schema.js";
import { evidenceRefSchema, revalidateOutputSchema, reviewOutputSchema } from "./types.js";
import { fixtureRoot } from "./test-helpers.js";

const {
  addClaudeModelArgs,
  acpxFailureMessage,
  assertCursorRuntimeVersionAllowed,
  acpxPromptRetries,
  addCodexConfigArgs,
  addCodexModelArgs,
  addCodexSandboxArgs,
  assertClaudeAuthContextSupported,
  assertClaudeVersionAllowed,
  buildAcpxJsonArgs,
  claudeArgs,
  claudeAuthContext,
  claudeEffort,
  claudeEnv,
  claudeExitCode,
  claudeFailureMessage,
  claudeTimeoutMs,
  codexFailureMessage,
  codexTimeoutMs,
  cursorAgentArgs,
  cursorEnv,
  cursorFailureMessage,
  cursorPrompt,
  cursorTimeoutMs,
  extractAcpxJson,
  extractCursorJson,
  extractClaudeStructuredOutput,
  extractOpencodeJson,
  parseAcpxJsonOutput,
  parseAcpxAgent,
  parseClaudeVersion,
  parseCodexJson,
  parseSemver,
  piThinkingLevel,
  providerExitCode,
  providerJsonSchema,
} = providerTesting;
const gatewayAndProtoTesting = providerTesting;

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

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

function terminalEnvelope(stopReason: string, id = 2): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { stopReason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  });
}

function expectStopReasonError(
  fn: () => unknown,
  expected: { code: string; exitCode: number; stopReason: string },
): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ClawpatchError);
    expect((err as ClawpatchError).code).toBe(expected.code);
    expect((err as ClawpatchError).exitCode).toBe(expected.exitCode);
    expect((err as Error).message).toContain(`stopReason="${expected.stopReason}"`);
    return;
  }
  throw new Error(`expected ClawpatchError with code ${expected.code}`);
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

  it("recovers an answer wrapped in a doubled opening brace", () => {
    const answer = '{"findings":[{"title":"x {y}"}],"inspected":{"files":["a.ts"]}}';
    const expected = { findings: [{ title: "x {y}" }], inspected: { files: ["a.ts"] } };

    expect(extractJson(`{${answer}})`)).toEqual(expected);
    expect(extractJson(`{"${answer}}`)).toEqual(expected);
  });

  it("returns null for text with no valid JSON", () => {
    expect(extractJson("no json here at all")).toBeNull();
    expect(extractJson("just some words { unbalanced")).toBeNull();
    expect(extractJson("{".repeat(200))).toBeNull();
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
  const originalCodexTimeout = process.env["CLAWPATCH_CODEX_TIMEOUT_MS"];
  const originalProviderTimeout = process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];

  afterEach(() => {
    if (originalCodexSandbox === undefined) {
      delete process.env["CLAWPATCH_CODEX_SANDBOX"];
    } else {
      process.env["CLAWPATCH_CODEX_SANDBOX"] = originalCodexSandbox;
    }
    if (originalCodexTimeout === undefined) {
      delete process.env["CLAWPATCH_CODEX_TIMEOUT_MS"];
    } else {
      process.env["CLAWPATCH_CODEX_TIMEOUT_MS"] = originalCodexTimeout;
    }
    if (originalProviderTimeout === undefined) {
      delete process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
    } else {
      process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"] = originalProviderTimeout;
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
      codexConfig: {
        model_provider: "local",
        "model_providers.local.base_url": "https://example.invalid/v1",
      },
      skipGitRepoCheck: false,
    });

    expect(args).toEqual([
      "exec",
      "-c",
      'model_provider="local"',
      "-c",
      'model_providers.local.base_url="https://example.invalid/v1"',
      "--model",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  it("renders primitive Codex passthrough values in stable key order", () => {
    const args = ["exec"];

    addCodexConfigArgs(args, {
      z_flag: true,
      model_provider: "local",
      "model_providers.local.max_retries": 2,
      "model_providers.local.optional": null,
    });

    expect(args).toEqual([
      "exec",
      "-c",
      'model_provider="local"',
      "-c",
      "model_providers.local.max_retries=2",
      "-c",
      "model_providers.local.optional=null",
      "-c",
      "z_flag=true",
    ]);
  });

  it("rejects unsafe Codex passthrough keys", () => {
    const args = ["exec"];

    expect(() => addCodexConfigArgs(args, { "model provider": "local" })).toThrow(
      /invalid Codex config key/u,
    );
  });

  it("rejects non-finite Codex passthrough numbers", () => {
    const args = ["exec"];

    expect(() => addCodexConfigArgs(args, { retries: Number.NaN })).toThrow(
      /finite number required/u,
    );
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

  it("uses Codex-specific timeout before generic provider timeout", () => {
    delete process.env["CLAWPATCH_CODEX_TIMEOUT_MS"];
    delete process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
    expect(codexTimeoutMs()).toBe(300_000);

    process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"] = "2000";
    expect(codexTimeoutMs()).toBe(2000);

    process.env["CLAWPATCH_CODEX_TIMEOUT_MS"] = "3000";
    expect(codexTimeoutMs()).toBe(3000);

    process.env["CLAWPATCH_CODEX_TIMEOUT_MS"] = "bad";
    expect(codexTimeoutMs()).toBe(300_000);
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

  it("normalizes nullable evidence line schemas for Codex strict schemas", () => {
    const schema = reviewJsonSchema as Record<string, unknown>;
    const findings = propertySchema(schema, "findings");
    const finding = itemSchema(findings);
    const evidence = itemSchema(propertySchema(finding, "evidence"));
    const endLine = propertySchema(evidence, "endLine");

    expect(endLine["anyOf"]).toBeUndefined();
    expect(endLine["type"]).toEqual(["integer", "null"]);
    expect(schemaKeys(endLine)).not.toContain("minimum");
    expect(evidence["additionalProperties"]).toBe(false);
    expect(evidence["required"]).toEqual(Object.keys(propertiesOf(evidence)));
  });

  it("keeps object schemas strict even when parser input fields are optional", () => {
    const schema = providerJsonSchema(reviewOutputSchema) as Record<string, unknown>;
    const findings = propertySchema(schema, "findings");
    const finding = itemSchema(findings);
    const inspected = propertySchema(schema, "inspected");

    for (const objectSchema of [schema, finding, inspected]) {
      expect(objectSchema["additionalProperties"]).toBe(false);
      expect(objectSchema["required"]).toEqual(Object.keys(propertiesOf(objectSchema)));
    }
    expect(finding["required"]).toContain("reproduction");
    expect(finding["required"]).toContain("minimumFixScope");
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
      "/tmp/clawpatch-cursor/prompt.txt",
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
      "Read the complete Clawpatch prompt from /tmp/clawpatch-cursor/prompt.txt. Follow it exactly. Return only the requested JSON object.",
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
      "/tmp/clawpatch-cursor/prompt.txt",
    );

    expect(args).toEqual([
      "--trust",
      "-p",
      "--output-format",
      "json",
      "--workspace",
      "/repo",
      "Read the complete Clawpatch prompt from /tmp/clawpatch-cursor/prompt.txt. Follow it exactly. Return only the requested JSON object.",
    ]);
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
    expect(prompt).toContain("Every evidence item must include startLine and endLine");
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

  it("uses semver CLI versions as the authoritative runtime version", () => {
    expect(() => assertCursorRuntimeVersionAllowed("2.5.0", "2.4.9")).not.toThrow();
    expect(() => assertCursorRuntimeVersionAllowed("2.4.9", "3.2.16")).toThrow(
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

describe("Claude provider helpers", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("builds read-only structured-output args with isolation flags", () => {
    const args = claudeArgs(
      { type: "object" },
      { model: null, reasoningEffort: null, skipGitRepoCheck: false },
      true,
      "isolated",
    );

    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      '{"type":"object"}',
      "--tools",
      "Read,Grep,Glob",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--bare",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-chrome",
    ]);
  });

  it("builds write-capable fix args only for non-read-only operations", () => {
    const args = claudeArgs(
      { type: "object" },
      { model: null, reasoningEffort: null, skipGitRepoCheck: false },
      false,
      "isolated",
    );

    expect(args).toContain("default");
    expect(args).toContain("acceptEdits");
    expect(args).not.toContain("Read,Grep,Glob");
    expect(args).not.toContain("dontAsk");
  });

  it("uses safe mode instead of bare mode for host auth context", () => {
    const args = claudeArgs(
      { type: "object" },
      { model: null, reasoningEffort: null, skipGitRepoCheck: false },
      true,
      "host",
    );

    expect(args).toContain("--safe-mode");
    expect(args).not.toContain("--bare");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
  });

  it("passes model and supported effort while ignoring skipGitRepoCheck", () => {
    const args = ["-p"];

    addClaudeModelArgs(args, {
      model: "sonnet",
      reasoningEffort: "xhigh",
      skipGitRepoCheck: true,
    });

    expect(args).toEqual(["-p", "--model", "sonnet", "--effort", "xhigh"]);
  });

  it("maps minimal to low and none to no effort flag", () => {
    expect(claudeEffort("minimal")).toBe("low");

    const args = ["-p"];
    addClaudeModelArgs(args, { model: null, reasoningEffort: "none", skipGitRepoCheck: false });

    expect(args).toEqual(["-p"]);
  });

  it("uses a default-deny env allowlist with optional API key", () => {
    process.env = {
      PATH: "/bin",
      HOME: "/secret-home",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "must-not-leak",
      CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak",
    };

    expect(claudeEnv(false, "/tmp/claude", "isolated")).toEqual({
      PATH: "/bin",
      HOME: "/tmp/claude/home",
      XDG_CONFIG_HOME: "/tmp/claude/xdg-config",
      XDG_CACHE_HOME: "/tmp/claude/xdg-cache",
      XDG_DATA_HOME: "/tmp/claude/xdg-data",
      TMPDIR: "/tmp/claude",
      TEMP: "/tmp/claude",
      TMP: "/tmp/claude",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(claudeEnv(true, "/tmp/claude", "isolated")).toEqual({
      PATH: "/bin",
      HOME: "/tmp/claude/home",
      XDG_CONFIG_HOME: "/tmp/claude/xdg-config",
      XDG_CACHE_HOME: "/tmp/claude/xdg-cache",
      XDG_DATA_HOME: "/tmp/claude/xdg-data",
      TMPDIR: "/tmp/claude",
      TEMP: "/tmp/claude",
      TMP: "/tmp/claude",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      ANTHROPIC_API_KEY: "secret",
    });
  });

  it("exposes only Claude host auth locators in host auth context", () => {
    process.env = {
      PATH: "/bin",
      HOME: "/host-home",
      USERPROFILE: "C:\\Users\\operator",
      CLAUDE_CONFIG_DIR: "/host-claude-config",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      ANTHROPIC_API_KEY: "api-key",
      OPENAI_API_KEY: "must-not-leak",
      DATABASE_URL: "must-not-leak",
    };

    expect(claudeEnv(true, "/tmp/claude", "host")).toEqual({
      PATH: "/bin",
      HOME: "/host-home",
      USERPROFILE: "C:\\Users\\operator",
      CLAUDE_CONFIG_DIR: "/host-claude-config",
      XDG_CONFIG_HOME: "/tmp/claude/xdg-config",
      XDG_CACHE_HOME: "/tmp/claude/xdg-cache",
      XDG_DATA_HOME: "/tmp/claude/xdg-data",
      TMPDIR: "/tmp/claude",
      TEMP: "/tmp/claude",
      TMP: "/tmp/claude",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      ANTHROPIC_API_KEY: "api-key",
    });
  });

  it("validates Claude auth context and safe-mode version", () => {
    delete process.env["CLAWPATCH_CLAUDE_AUTH_CONTEXT"];
    expect(claudeAuthContext()).toBe("isolated");

    process.env["CLAWPATCH_CLAUDE_AUTH_CONTEXT"] = "host";
    expect(claudeAuthContext()).toBe("host");
    expect(() => assertClaudeAuthContextSupported("2.1.169 (Claude Code)", "host")).not.toThrow();
    expect(() => assertClaudeAuthContextSupported("2.1.168 (Claude Code)", "host")).toThrow(
      /2\.1\.169 or newer/u,
    );
    expect(() => assertClaudeAuthContextSupported("unknown", "host")).toThrow(
      /2\.1\.169 or newer/u,
    );

    process.env["CLAWPATCH_CLAUDE_AUTH_CONTEXT"] = "everything";
    expect(() => claudeAuthContext()).toThrow(/must be isolated or host/u);
  });

  it("passes Vertex AI auth env vars only when auth is included", () => {
    process.env = {
      PATH: "/bin",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_BASE_URL: "https://llm-gateway.example.com",
      ANTHROPIC_AUTH_TOKEN: "gateway-token",
      ANTHROPIC_VERTEX_PROJECT_ID: "project-id",
      ANTHROPIC_VERTEX_REGION: "us-east5",
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex-gateway.example.com",
      CLOUD_ML_REGION: "us-east5",
      GOOGLE_APPLICATION_CREDENTIALS: "/var/creds/google.json",
      GOOGLE_CLOUD_PROJECT: "project-id",
      GCLOUD_PROJECT: "legacy-project",
      CLOUDSDK_CORE_PROJECT: "sdk-project",
      CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
      OPENAI_API_KEY: "must-not-leak",
    };

    expect(claudeEnv(false, "/tmp/claude", "isolated")).toEqual({
      PATH: "/bin",
      HOME: "/tmp/claude/home",
      XDG_CONFIG_HOME: "/tmp/claude/xdg-config",
      XDG_CACHE_HOME: "/tmp/claude/xdg-cache",
      XDG_DATA_HOME: "/tmp/claude/xdg-data",
      TMPDIR: "/tmp/claude",
      TEMP: "/tmp/claude",
      TMP: "/tmp/claude",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(claudeEnv(true, "/tmp/claude", "isolated")).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_BASE_URL: "https://llm-gateway.example.com",
      ANTHROPIC_AUTH_TOKEN: "gateway-token",
      ANTHROPIC_VERTEX_PROJECT_ID: "project-id",
      ANTHROPIC_VERTEX_REGION: "us-east5",
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex-gateway.example.com",
      CLOUD_ML_REGION: "us-east5",
      GOOGLE_APPLICATION_CREDENTIALS: "/var/creds/google.json",
      GOOGLE_CLOUD_PROJECT: "project-id",
      GCLOUD_PROJECT: "legacy-project",
      CLOUDSDK_CORE_PROJECT: "sdk-project",
      CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
    });
    expect(claudeEnv(true, "/tmp/claude", "isolated")).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("passes Bedrock auth env vars only when auth is included", () => {
    process.env = {
      PATH: "/bin",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_PROFILE: "clawpatch",
      AWS_ACCESS_KEY_ID: "access-key",
      AWS_SECRET_ACCESS_KEY: "secret-key",
      AWS_SESSION_TOKEN: "session-token",
      AWS_SHARED_CREDENTIALS_FILE: "/var/aws/credentials",
      AWS_CONFIG_FILE: "/var/aws/config",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/clawpatch",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/var/aws/web-identity-token",
      DATABASE_URL: "must-not-leak",
    };

    expect(claudeEnv(false, "/tmp/claude", "isolated")).not.toHaveProperty(
      "CLAUDE_CODE_USE_BEDROCK",
    );
    expect(claudeEnv(true, "/tmp/claude", "isolated")).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_PROFILE: "clawpatch",
      AWS_ACCESS_KEY_ID: "access-key",
      AWS_SECRET_ACCESS_KEY: "secret-key",
      AWS_SESSION_TOKEN: "session-token",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
      AWS_SHARED_CREDENTIALS_FILE: "/var/aws/credentials",
      AWS_CONFIG_FILE: "/var/aws/config",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/clawpatch",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/var/aws/web-identity-token",
    });
    expect(claudeEnv(true, "/tmp/claude", "isolated")).not.toHaveProperty("DATABASE_URL");
  });

  it("passes AWS_PROFILE only with explicit AWS config or credentials file paths", () => {
    process.env = {
      PATH: "/bin",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_PROFILE: "clawpatch",
    };

    expect(claudeEnv(true, "/tmp/claude", "isolated")).not.toHaveProperty("AWS_PROFILE");

    process.env["AWS_CONFIG_FILE"] = "/var/aws/config";
    expect(claudeEnv(true, "/tmp/claude", "isolated")).toMatchObject({
      AWS_CONFIG_FILE: "/var/aws/config",
      AWS_PROFILE: "clawpatch",
    });

    delete process.env["AWS_CONFIG_FILE"];
    process.env["AWS_SHARED_CREDENTIALS_FILE"] = "/var/aws/credentials";
    expect(claudeEnv(true, "/tmp/claude", "isolated")).toMatchObject({
      AWS_SHARED_CREDENTIALS_FILE: "/var/aws/credentials",
      AWS_PROFILE: "clawpatch",
    });
  });

  it("preserves a Windows-style Path variable in the Claude env allowlist", () => {
    process.env = {
      Path: "C:\\Tools",
      ANTHROPIC_API_KEY: "secret",
    };

    expect(claudeEnv(true, "C:\\Temp\\claude", "isolated")).toMatchObject({
      Path: "C:\\Tools",
      ANTHROPIC_API_KEY: "secret",
    });
    expect(claudeEnv(true, "C:\\Temp\\claude", "isolated")).not.toHaveProperty("PATH");
  });

  it("extracts structured_output from Claude JSON envelopes", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      structured_output: { findings: [], inspected: { files: [], symbols: [], notes: [] } },
    });

    expect(extractClaudeStructuredOutput(stdout)).toEqual({
      findings: [],
      inspected: { files: [], symbols: [], notes: [] },
    });
  });

  it("extracts structured_output when prose surrounds the JSON envelope", () => {
    const stdout =
      "leading text\n" +
      JSON.stringify({ type: "result", structured_output: { outcome: "fixed" } }) +
      "\ntrailing text";

    expect(extractClaudeStructuredOutput(stdout)).toEqual({ outcome: "fixed" });
  });

  it("uses the first JSON envelope with structured_output when multiple objects appear", () => {
    const stdout = [
      JSON.stringify({ note: "ignore" }),
      JSON.stringify({ structured_output: { ok: true } }),
      JSON.stringify({ structured_output: { ok: false } }),
    ].join("\n");

    expect(extractClaudeStructuredOutput(stdout)).toEqual({ ok: true });
  });

  it("throws malformed-output for empty or malformed Claude output", () => {
    expectMalformed(() => extractClaudeStructuredOutput(""), /claude provider produced no output/u);
    expectMalformed(
      () => extractClaudeStructuredOutput("not json"),
      /claude provider produced no JSON envelope/u,
    );
    expectMalformed(
      () => extractClaudeStructuredOutput(JSON.stringify({ result: "{}" })),
      /missing structured_output/u,
    );
    expectMalformed(
      () => extractClaudeStructuredOutput(JSON.stringify({ structured_output: "nope" })),
      /structured_output is not an object/u,
    );
  });

  it("turns Claude error envelopes into provider failures", () => {
    try {
      extractClaudeStructuredOutput(JSON.stringify({ error: { type: "authentication_failed" } }));
    } catch (err) {
      expect(err).toBeInstanceOf(ClawpatchError);
      expect((err as ClawpatchError).exitCode).toBe(4);
      expect((err as ClawpatchError).code).toBe("provider-failure");
      return;
    }
    throw new Error("expected Claude provider failure");
  });

  it("classifies string Claude error envelopes", () => {
    try {
      extractClaudeStructuredOutput(JSON.stringify({ error: "authentication_failed" }));
    } catch (err) {
      expect(err).toBeInstanceOf(ClawpatchError);
      expect((err as ClawpatchError).message).toContain("authentication_failed");
      expect((err as ClawpatchError).exitCode).toBe(4);
      return;
    }
    throw new Error("expected Claude provider failure");
  });

  it("does not preview arbitrary or token-shaped string Claude errors", () => {
    for (const secret of ["SOURCE CONTEXT SECRET", "sk-ant-secret-shaped-value"]) {
      try {
        extractClaudeStructuredOutput(JSON.stringify({ error: secret }));
      } catch (err) {
        expect(err).toBeInstanceOf(ClawpatchError);
        expect((err as ClawpatchError).message).toBe("claude provider error: provider-error");
        expect((err as ClawpatchError).message).not.toContain(secret);
        continue;
      }
      throw new Error("expected Claude provider failure");
    }
  });

  it("does not include stdout or prompt previews in Claude failure messages", () => {
    const message = claudeFailureMessage("SOURCE_CONTEXT_SECRET", "SOURCE_CONTEXT_SECRET", 1);

    expect(message).toBe("claude provider failed");
    expect(message).not.toContain("SOURCE_CONTEXT_SECRET");
  });

  it("classifies Claude stderr failures without leaking stderr text", () => {
    const auth = claudeFailureMessage("", "authentication failed for SOURCE_CONTEXT_SECRET", 1);
    const quota = claudeFailureMessage("", "rate limit exceeded for SOURCE_CONTEXT_SECRET", 1);

    expect(auth).toBe("claude provider auth/config failed");
    expect(quota).toBe("claude provider quota/rate-limit failed");
    expect(auth).not.toContain("SOURCE_CONTEXT_SECRET");
    expect(quota).not.toContain("SOURCE_CONTEXT_SECRET");
  });

  it("uses redacted Claude stdout envelope signals for nonzero failures", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      api_error_status: 401,
      error: { type: "authentication_failed", message: "SOURCE_CONTEXT_SECRET" },
      result: "SOURCE_CONTEXT_SECRET",
    });

    const message = claudeFailureMessage(stdout, "", 1);

    expect(message).toContain("claude provider auth/config failed");
    expect(message).toContain("error=authentication_failed");
    expect(message).not.toContain("SOURCE_CONTEXT_SECRET");
    expect(claudeExitCode(stdout, "", 1)).toBe(4);
  });

  it("classifies Claude print-mode API status envelopes", () => {
    const auth = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      result: "SOURCE_CONTEXT_SECRET",
    });
    const quota = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "SOURCE_CONTEXT_SECRET",
    });

    expect(claudeFailureMessage(auth, "", 1)).toContain("claude provider auth/config failed");
    expect(claudeExitCode(auth, "", 1)).toBe(4);
    expect(claudeFailureMessage(quota, "", 1)).toContain("claude provider quota/rate-limit failed");
    expect(claudeExitCode(quota, "", 1)).toBe(5);
    expect(claudeFailureMessage(auth, "", 1)).not.toContain("SOURCE_CONTEXT_SECRET");
    expect(claudeFailureMessage(quota, "", 1)).not.toContain("SOURCE_CONTEXT_SECRET");
  });

  it("surfaces the reported OAuth failure shape without leaking result text", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", error: "authentication_failed" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
        terminal_reason: "completed",
      }),
    ].join("\n");

    const message = claudeFailureMessage(stdout, "", 1);

    expect(message).toContain("claude provider auth/config failed");
    expect(message).toContain("error=authentication_failed");
    expect(message).toContain("is_error=true");
    expect(message).toContain("reason=not-logged-in");
    expect(message).not.toContain("Please run /login");
    expect(claudeExitCode(stdout, "", 1)).toBe(4);
  });

  it("omits Claude error.message from stdout failure signals", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      error: { code: "invalid_request", message: "SOURCE_CONTEXT_SECRET" },
      result: "SOURCE_CONTEXT_SECRET",
    });

    const message = claudeFailureMessage(stdout, "", 1);

    expect(message).toContain("error=invalid_request");
    expect(message).not.toContain("SOURCE_CONTEXT_SECRET");
  });

  it("classifies Claude provider failures by exit convention", () => {
    expect(claudeExitCode("", "authentication failed", 1)).toBe(4);
    expect(claudeExitCode("", "rate limit exceeded", 1)).toBe(5);
    expect(claudeExitCode("", "command timed out after 1ms", 124)).toBe(1);
    expect(claudeExitCode("", "other", 1)).toBe(1);
  });

  it("parses Claude versions and blocks verified vulnerable ranges", () => {
    expect(parseClaudeVersion("2.1.144 (Claude Code)")).toEqual([2, 1, 144]);
    expect(parseClaudeVersion("not a version")).toBeNull();

    expect(() => assertClaudeVersionAllowed("2.1.52 (Claude Code)")).toThrow(/blocked/u);
    expect(() => assertClaudeVersionAllowed("2.1.63 (Claude Code)")).toThrow(/blocked/u);
    expect(() => assertClaudeVersionAllowed("2.1.83 (Claude Code)")).toThrow(/blocked/u);
    expect(() => assertClaudeVersionAllowed("2.1.53 (Claude Code)")).not.toThrow();
    expect(() => assertClaudeVersionAllowed("2.1.84 (Claude Code)")).not.toThrow();
    expect(() => assertClaudeVersionAllowed("2.1.144 (Claude Code)")).not.toThrow();
    expect(() => assertClaudeVersionAllowed("unknown")).not.toThrow();
  });

  it("uses Claude-specific timeout before generic provider timeout", () => {
    delete process.env["CLAWPATCH_CLAUDE_TIMEOUT_MS"];
    delete process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
    expect(claudeTimeoutMs()).toBe(180_000);

    process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"] = "2000";
    expect(claudeTimeoutMs()).toBe(2000);

    process.env["CLAWPATCH_CLAUDE_TIMEOUT_MS"] = "3000";
    expect(claudeTimeoutMs()).toBe(3000);

    process.env["CLAWPATCH_CLAUDE_TIMEOUT_MS"] = "bad";
    expect(claudeTimeoutMs()).toBe(180_000);
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

function propertySchema(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = propertiesOf(schema)[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`missing schema property: ${name}`);
  }
  return value as Record<string, unknown>;
}

function itemSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const value = schema["items"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("missing item schema");
  }
  return value as Record<string, unknown>;
}

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  const value = schema["properties"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("missing schema properties");
  }
  return value as Record<string, unknown>;
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

describe("providerExitCode", () => {
  it("classifies auth failures from stdout-only provider output", () => {
    expect(providerExitCode("Unauthorized: Wrong API Key", "")).toBe(4);
    expect(providerExitCode("auth required", "")).toBe(4);
    expect(providerExitCode("Incorrect API key provided", "")).toBe(4);
    expect(providerExitCode("invalid_api_key", "")).toBe(4);
    expect(providerExitCode("API key is required", "")).toBe(4);
    expect(providerExitCode("API key not found", "")).toBe(4);
    expect(providerExitCode("OPENAI_API_KEY is not set", "")).toBe(4);
    expect(providerExitCode("insufficient permissions", "")).toBe(4);
    expect(providerExitCode("api.responses.write scope is required", "")).toBe(4);
    expect(providerExitCode("AuthenticationError: invalid credentials", "")).toBe(4);
    expect(providerExitCode("authentication_error", "")).toBe(4);
    expect(providerExitCode("AUTH_REQUIRED", "")).toBe(4);
  });

  it("classifies quota failures from stdout-only provider output", () => {
    expect(providerExitCode("quota exceeded for this organization", "")).toBe(5);
    expect(providerExitCode("You exceeded your current quota", "")).toBe(5);
    expect(providerExitCode("insufficient_quota", "")).toBe(5);
    expect(providerExitCode("quota_exceeded", "")).toBe(5);
    expect(providerExitCode("RateLimitError: retry later", "")).toBe(5);
    expect(providerExitCode("rate_limit_error", "")).toBe(5);
  });

  it("does not classify benign auth-looking stdout as auth failures", () => {
    expect(providerExitCode("author: Jane", "")).toBe(1);
    expect(providerExitCode("registered oauth-callback route", "")).toBe(1);
    expect(providerExitCode("authority metadata loaded", "")).toBe(1);
  });

  it("does not classify generic rate-limiting discussion as quota failures", () => {
    expect(providerExitCode("consider adding rate-limiting to this endpoint", "")).toBe(1);
    expect(providerExitCode("document the rate limit policy for future work", "")).toBe(1);
  });

  it("keeps classifying real rate-limit failures", () => {
    expect(providerExitCode("rate limit exceeded for this organization", "")).toBe(5);
  });

  it("keeps classifying stderr failures", () => {
    expect(providerExitCode("", "please login before running the provider")).toBe(4);
    expect(providerExitCode("", "expired API key")).toBe(4);
    expect(providerExitCode("", "auth credentials not found")).toBe(4);
  });

  it("keeps generic failures when neither stream has a known signal", () => {
    expect(providerExitCode("process exited unexpectedly", "")).toBe(1);
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

  it("prefers a later complete message after a stale retry attempt", () => {
    const stdout = [
      textChunk("agent_message_chunk", '{"ok":false}'),
      textChunk("agent_message_chunk", '{"ok":true}'),
    ].join("\n");

    expect(
      parseAcpxJsonOutput(stdout, (output) => {
        if (
          typeof output === "object" &&
          output !== null &&
          (output as { ok?: unknown }).ok === true
        ) {
          return output;
        }
        throw new Error("wrong attempt");
      }),
    ).toEqual({ ok: true });
  });

  it("recovers from a partial message before a retry attempt", () => {
    const stdout = [
      textChunk("agent_message_chunk", '{"ok":'),
      textChunk("agent_message_chunk", '{"ok":true}'),
    ].join("\n");

    expect(parseAcpxJsonOutput(stdout, (output) => output)).toEqual({ ok: true });
  });

  it("keeps scanning when a retry-safe suffix is only a nested object", () => {
    const stdout = [
      textChunk("agent_message_chunk", '{"findings":[],"inspected":'),
      textChunk("agent_message_chunk", '{"files":[],"symbols":[],"notes":[]}}'),
    ].join("\n");

    expect(parseAcpxJsonOutput(stdout, (output) => reviewOutputSchema.parse(output))).toEqual({
      findings: [],
      inspected: { files: [], symbols: [], notes: [] },
    });
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

  it("preserves end_turn happy path with message chunks", () => {
    const stdout = [
      textChunk("agent_message_chunk", '{"ok":'),
      textChunk("agent_message_chunk", "true}"),
      terminalEnvelope("end_turn"),
    ].join("\n");

    expect(extractAcpxJson(stdout)).toEqual({ ok: true });
  });

  it("surfaces stopReason cancelled as agent-cancelled", () => {
    const stdout = [
      updateEnvelope({ sessionUpdate: "usage_update", usage: { inputTokens: 1, outputTokens: 0 } }),
      terminalEnvelope("cancelled"),
    ].join("\n");

    expectStopReasonError(() => extractAcpxJson(stdout), {
      code: "agent-cancelled",
      exitCode: 1,
      stopReason: "cancelled",
    });
  });

  it("surfaces stopReason refusal as agent-refused", () => {
    const stdout = terminalEnvelope("refusal");

    expectStopReasonError(() => extractAcpxJson(stdout), {
      code: "agent-refused",
      exitCode: 1,
      stopReason: "refusal",
    });
  });

  it("surfaces stopReason max_tokens as agent-truncated", () => {
    const stdout = [
      textChunk("agent_message_chunk", '{"partial":'),
      terminalEnvelope("max_tokens"),
    ].join("\n");

    expectStopReasonError(() => extractAcpxJson(stdout), {
      code: "agent-truncated",
      exitCode: 8,
      stopReason: "max_tokens",
    });
  });

  it("surfaces stopReason max_turn_requests as agent-truncated", () => {
    const stdout = terminalEnvelope("max_turn_requests");

    expectStopReasonError(() => extractAcpxJson(stdout), {
      code: "agent-truncated",
      exitCode: 8,
      stopReason: "max_turn_requests",
    });
  });

  it("maps unknown stopReason defensively to agent-cancelled", () => {
    const stdout = terminalEnvelope("future_reason_xyz");

    expectStopReasonError(() => extractAcpxJson(stdout), {
      code: "agent-cancelled",
      exitCode: 8,
      stopReason: "future_reason_xyz",
    });
  });

  it("falls back to current behavior with no terminal envelope", () => {
    const stdout = [
      textChunk("agent_message_chunk", '{"legacy":'),
      textChunk("agent_message_chunk", "true}"),
    ].join("\n");

    expect(extractAcpxJson(stdout)).toEqual({ legacy: true });
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

  it("classifies opencode stderr-style error events as provider auth failures", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: { data: { message: "auth credentials not found" } },
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

  it("classifies opencode stderr-style error events as provider quota failures", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: { data: { message: "rate limit" } },
    });

    try {
      extractOpencodeJson(stdout);
    } catch (err) {
      expect(err).toBeInstanceOf(ClawpatchError);
      expect((err as ClawpatchError).exitCode).toBe(5);
      return;
    }
    throw new Error("expected provider quota failure");
  });
});

describe("providerByName", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "rejects inherited object key %s as an unsupported provider",
    (name) => {
      expect(() => providerByName(name)).toThrow(`unsupported provider: ${name}`);
    },
  );

  it("returns provider instances for optional CLI-backed providers", () => {
    expect(providerByName("acpx").name).toBe("acpx");
    expect(providerByName("claude").name).toBe("claude");
    expect(providerByName("grok").name).toBe("grok");
    expect(providerByName("opencode").name).toBe("opencode");
    expect(providerByName("pi").name).toBe("pi");
    expect(providerByName("cursor").name).toBe("cursor");
  });

  it("returns the gateway provider for HTTP-based reviews", () => {
    expect(providerByName("gateway").name).toBe("gateway");
  });

  it("returns the proto provider (drives protoCLI via acpx --agent escape hatch)", () => {
    expect(providerByName("proto").name).toBe("proto");
  });

  it("still supports codex, mock, and mock-fail", () => {
    expect(providerByName("codex").name).toBe("codex");
    expect(providerByName("mock").name).toBe("mock");
    expect(providerByName("mock-fail").name).toBe("mock-fail");
  });

  it("rejects direct model API providers", () => {
    expect(() => providerByName("minimax")).toThrow(/unsupported provider: minimax/u);
    expect(() => providerByName("deepseek")).toThrow(/unsupported provider: deepseek/u);
  });
});

describe("proto provider helpers", () => {
  const ENV_KEYS = [
    "CLAWPATCH_PROTO_MODEL",
    "CLAWPATCH_PROTO_TIMEOUT_MS",
    "CLAWPATCH_PROVIDER_TIMEOUT_MS",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) snapshot[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("protoAgentCommand defaults to protolabs/reasoning when nothing is set", () => {
    // eslint-disable-next-line no-underscore-dangle
    const cmd = gatewayAndProtoTesting.protoAgentCommand({
      model: null,
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(cmd).toBe("proto --acp -m protolabs/reasoning");
  });

  it("options.model > CLAWPATCH_PROTO_MODEL > default", () => {
    process.env["CLAWPATCH_PROTO_MODEL"] = "env-model";
    // eslint-disable-next-line no-underscore-dangle
    const fromOpts = gatewayAndProtoTesting.protoAgentCommand({
      model: "opts-model",
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(fromOpts).toBe("proto --acp -m opts-model");
    // eslint-disable-next-line no-underscore-dangle
    const fromEnv = gatewayAndProtoTesting.protoAgentCommand({
      model: null,
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(fromEnv).toBe("proto --acp -m env-model");
  });

  it("protoAgentCommand refuses a model id that could smuggle shell syntax", () => {
    for (const model of ["m; touch x", "m $(id)", "m`id`", "a b", "m'x", '"m"', "-m", "m\nx", ""]) {
      expect(() =>
        gatewayAndProtoTesting.protoAgentCommand({
          model,
          reasoningEffort: null,
          skipGitRepoCheck: false,
        }),
      ).toThrow(/refusing model/u);
    }
    process.env["CLAWPATCH_PROTO_MODEL"] = "x;y";
    expect(() =>
      gatewayAndProtoTesting.protoAgentCommand({
        model: null,
        reasoningEffort: null,
        skipGitRepoCheck: false,
      }),
    ).toThrow(/refusing model/u);
  });

  it("protoAgentCommand accepts real model ids", () => {
    for (const model of [
      "protolabs/reasoning",
      "gpt-5.1",
      "anthropic/claude-sonnet-4:beta",
      "m@1.2+x",
    ]) {
      expect(
        gatewayAndProtoTesting.protoAgentCommand({
          model,
          reasoningEffort: null,
          skipGitRepoCheck: false,
        }),
      ).toBe(`proto --acp -m ${model}`);
    }
  });

  it("buildProtoAcpxArgs (read mode) uses --agent escape hatch and approve-reads", () => {
    // eslint-disable-next-line no-underscore-dangle
    const args = gatewayAndProtoTesting.buildProtoAcpxArgs(
      "/some/root",
      { model: null, reasoningEffort: null, skipGitRepoCheck: false },
      "read",
    );
    expect(args[0]).toBe("--agent");
    expect(args[1]).toBe("proto --acp -m protolabs/reasoning");
    expect(args).toContain("--cwd");
    expect(args).toContain("/some/root");
    expect(args).toContain("--approve-reads");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("--json-strict");
    expect(args).toContain("--suppress-reads");
    // tail of args: exec --file -
    expect(args.slice(-3)).toEqual(["exec", "--file", "-"]);
  });

  it("buildProtoAcpxArgs (approve mode) uses --approve-all (write-capable)", () => {
    // eslint-disable-next-line no-underscore-dangle
    const args = gatewayAndProtoTesting.buildProtoAcpxArgs(
      "/r",
      { model: null, reasoningEffort: null, skipGitRepoCheck: false },
      "approve",
    );
    expect(args).toContain("--approve-all");
    expect(args).not.toContain("--approve-reads");
  });

  it("protoTimeoutMs honors CLAWPATCH_PROTO_TIMEOUT_MS then provider-wide fallback then 5-min default", () => {
    // eslint-disable-next-line no-underscore-dangle
    expect(gatewayAndProtoTesting.protoTimeoutMs()).toBe(5 * 60 * 1000);
    process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"] = "120000";
    // eslint-disable-next-line no-underscore-dangle
    expect(gatewayAndProtoTesting.protoTimeoutMs()).toBe(120000);
    process.env["CLAWPATCH_PROTO_TIMEOUT_MS"] = "90000";
    // eslint-disable-next-line no-underscore-dangle
    expect(gatewayAndProtoTesting.protoTimeoutMs()).toBe(90000); // proto-specific wins
  });

  it("protoTimeoutMs rejects garbage values (falls back to 5-min default)", () => {
    process.env["CLAWPATCH_PROTO_TIMEOUT_MS"] = "not-a-number";
    // eslint-disable-next-line no-underscore-dangle
    expect(gatewayAndProtoTesting.protoTimeoutMs()).toBe(5 * 60 * 1000);
    process.env["CLAWPATCH_PROTO_TIMEOUT_MS"] = "-1";
    // eslint-disable-next-line no-underscore-dangle
    expect(gatewayAndProtoTesting.protoTimeoutMs()).toBe(5 * 60 * 1000);
  });
});

describe("gateway provider config", () => {
  const ENV_KEYS = [
    "GATEWAY_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CLAWPATCH_GATEWAY_MODEL",
    "CLAWPATCH_GATEWAY_TIMEOUT_MS",
    "CLAWPATCH_PROVIDER_TIMEOUT_MS",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) snapshot[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("throws ClawpatchError(provider-auth) when no API key is set", () => {
    expect(() =>
      // eslint-disable-next-line no-underscore-dangle
      gatewayAndProtoTesting.gatewayConfig({
        model: null,
        reasoningEffort: null,
        skipGitRepoCheck: false,
      }),
    ).toThrowError(ClawpatchError);
  });

  it("prefers GATEWAY_API_KEY over OPENAI_API_KEY", () => {
    process.env["GATEWAY_API_KEY"] = "gw-primary";
    process.env["OPENAI_API_KEY"] = "openai-fallback";
    // eslint-disable-next-line no-underscore-dangle
    const cfg = gatewayAndProtoTesting.gatewayConfig({
      model: null,
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(cfg.apiKey).toBe("gw-primary");
  });

  it("falls back to OPENAI_API_KEY when GATEWAY_API_KEY is unset", () => {
    process.env["OPENAI_API_KEY"] = "openai-only";
    // eslint-disable-next-line no-underscore-dangle
    const cfg = gatewayAndProtoTesting.gatewayConfig({
      model: null,
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(cfg.apiKey).toBe("openai-only");
  });

  it("strips trailing slashes from OPENAI_BASE_URL", () => {
    process.env["GATEWAY_API_KEY"] = "k";
    process.env["OPENAI_BASE_URL"] = "https://gateway.example/v1////";
    // eslint-disable-next-line no-underscore-dangle
    const cfg = gatewayAndProtoTesting.gatewayConfig({
      model: null,
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(cfg.baseUrl).toBe("https://gateway.example/v1");
  });

  it("defaults to api.proto-labs.ai when OPENAI_BASE_URL is unset", () => {
    process.env["GATEWAY_API_KEY"] = "k";
    // eslint-disable-next-line no-underscore-dangle
    const cfg = gatewayAndProtoTesting.gatewayConfig({
      model: null,
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(cfg.baseUrl).toBe("https://api.proto-labs.ai/v1");
  });

  it("options.model wins over CLAWPATCH_GATEWAY_MODEL wins over default", () => {
    process.env["GATEWAY_API_KEY"] = "k";
    process.env["CLAWPATCH_GATEWAY_MODEL"] = "env-model";
    // eslint-disable-next-line no-underscore-dangle
    const fromOpts = gatewayAndProtoTesting.gatewayConfig({
      model: "opts-model",
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(fromOpts.model).toBe("opts-model");
    // eslint-disable-next-line no-underscore-dangle
    const fromEnv = gatewayAndProtoTesting.gatewayConfig({
      model: null,
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(fromEnv.model).toBe("env-model");
    delete process.env["CLAWPATCH_GATEWAY_MODEL"];
    // eslint-disable-next-line no-underscore-dangle
    const fromDefault = gatewayAndProtoTesting.gatewayConfig({
      model: null,
      reasoningEffort: null,
      skipGitRepoCheck: false,
    });
    expect(fromDefault.model).toBe("protolabs/smart");
  });

  it("parses CLAWPATCH_GATEWAY_TIMEOUT_MS and rejects garbage values", () => {
    process.env["GATEWAY_API_KEY"] = "k";
    process.env["CLAWPATCH_GATEWAY_TIMEOUT_MS"] = "12345";
    // eslint-disable-next-line no-underscore-dangle
    expect(
      gatewayAndProtoTesting.gatewayConfig({
        model: null,
        reasoningEffort: null,
        skipGitRepoCheck: false,
      }).timeoutMs,
    ).toBe(12345);
    process.env["CLAWPATCH_GATEWAY_TIMEOUT_MS"] = "not-a-number";
    // eslint-disable-next-line no-underscore-dangle
    expect(
      gatewayAndProtoTesting.gatewayConfig({
        model: null,
        reasoningEffort: null,
        skipGitRepoCheck: false,
      }).timeoutMs,
    ).toBe(300000);
    process.env["CLAWPATCH_GATEWAY_TIMEOUT_MS"] = "-1";
    // eslint-disable-next-line no-underscore-dangle
    expect(
      gatewayAndProtoTesting.gatewayConfig({
        model: null,
        reasoningEffort: null,
        skipGitRepoCheck: false,
      }).timeoutMs,
    ).toBe(300000);
  });
});

describe("gateway provider check()", () => {
  const saved = {
    gw: process.env["GATEWAY_API_KEY"],
    oa: process.env["OPENAI_API_KEY"],
    base: process.env["OPENAI_BASE_URL"],
  };

  afterEach(() => {
    if (saved.gw === undefined) delete process.env["GATEWAY_API_KEY"];
    else process.env["GATEWAY_API_KEY"] = saved.gw;
    if (saved.oa === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = saved.oa;
    if (saved.base === undefined) delete process.env["OPENAI_BASE_URL"];
    else process.env["OPENAI_BASE_URL"] = saved.base;
  });

  it("returns a fingerprint string when env is configured (no network call)", async () => {
    delete process.env["OPENAI_API_KEY"];
    process.env["GATEWAY_API_KEY"] = "test-key";
    process.env["OPENAI_BASE_URL"] = "https://my.gateway/v1";
    const out = await providerByName("gateway").check("/tmp");
    expect(out).toContain("gateway");
    expect(out).toContain("https://my.gateway/v1");
    expect(out).toContain("protolabs/smart");
    expect(out).not.toContain("test-key"); // never leak the secret into stdout
  });

  it("throws ClawpatchError when no API key is available", async () => {
    delete process.env["GATEWAY_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    await expect(providerByName("gateway").check("/tmp")).rejects.toThrow(ClawpatchError);
  });
});

function buildToleranceFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "x",
    category: "bug",
    severity: "low",
    confidence: "low",
    evidence: [],
    reasoning: "r",
    reproduction: null,
    recommendation: "rec",
    whyTestsDoNotAlreadyCoverThis: "",
    suggestedRegressionTest: null,
    minimumFixScope: "",
    ...overrides,
  };
}

function buildToleranceOutput(finding: Record<string, unknown>): Record<string, unknown> {
  return {
    findings: [finding],
    inspected: { files: [], symbols: [], notes: [] },
  };
}

describe("reviewOutputSchema tolerance", () => {
  it("accepts findings with null reproduction", () => {
    const parsed = reviewOutputSchema.parse(
      buildToleranceOutput(buildToleranceFinding({ reproduction: null })),
    );
    expect(parsed.findings[0]!.reproduction).toBeNull();
  });

  it("accepts findings with omitted reproduction (becomes null)", () => {
    const finding = buildToleranceFinding();
    delete finding["reproduction"];
    const parsed = reviewOutputSchema.parse(buildToleranceOutput(finding));
    expect(parsed.findings[0]!.reproduction).toBeNull();
  });

  it("accepts findings with omitted minimumFixScope (becomes empty string)", () => {
    const finding = buildToleranceFinding();
    delete finding["minimumFixScope"];
    const parsed = reviewOutputSchema.parse(buildToleranceOutput(finding));
    expect(parsed.findings[0]!.minimumFixScope).toBe("");
  });
});

describe("evidenceRefSchema tolerance", () => {
  it("accepts startLine 0 and normalizes to null", () => {
    const parsed = evidenceRefSchema.parse({
      path: "src/index.ts",
      startLine: 0,
      endLine: 5,
      symbol: null,
      quote: null,
    });
    expect(parsed.startLine).toBeNull();
    expect(parsed.endLine).toBeNull();
  });

  it("accepts endLine 0 and normalizes to null", () => {
    const parsed = evidenceRefSchema.parse({
      path: "src/index.ts",
      startLine: 5,
      endLine: 0,
      symbol: null,
      quote: null,
    });
    expect(parsed.startLine).toBeNull();
    expect(parsed.endLine).toBeNull();
  });
});

describe("acpxPromptRetries", () => {
  afterEach(() => {
    delete process.env["CLAWPATCH_ACPX_PROMPT_RETRIES"];
  });

  it("defaults to 1 when env var is unset", () => {
    delete process.env["CLAWPATCH_ACPX_PROMPT_RETRIES"];
    expect(acpxPromptRetries()).toBe(1);
  });

  it("respects a numeric env override", () => {
    withEnv("CLAWPATCH_ACPX_PROMPT_RETRIES", "3", () => {
      expect(acpxPromptRetries()).toBe(3);
    });
  });

  it("treats 0 as a valid override (disables retries)", () => {
    withEnv("CLAWPATCH_ACPX_PROMPT_RETRIES", "0", () => {
      expect(acpxPromptRetries()).toBe(0);
    });
  });

  it("falls back to 1 on invalid input", () => {
    withEnv("CLAWPATCH_ACPX_PROMPT_RETRIES", "not-a-number", () => {
      expect(acpxPromptRetries()).toBe(1);
    });
  });

  it("falls back to 1 on negative input", () => {
    withEnv("CLAWPATCH_ACPX_PROMPT_RETRIES", "-2", () => {
      expect(acpxPromptRetries()).toBe(1);
    });
  });
});

describe("buildAcpxJsonArgs", () => {
  afterEach(() => {
    delete process.env["CLAWPATCH_ACPX_PROMPT_RETRIES"];
  });

  it("includes --prompt-retries 1 by default", () => {
    delete process.env["CLAWPATCH_ACPX_PROMPT_RETRIES"];
    const args = buildAcpxJsonArgs("/tmp/repo", null, "read");
    expect(args).toEqual([
      "--cwd",
      "/tmp/repo",
      "--approve-reads",
      "--format",
      "json",
      "--json-strict",
      "--suppress-reads",
      "--prompt-retries",
      "1",
      "codex",
      "exec",
      "--file",
      "-",
    ]);
  });

  it("honors CLAWPATCH_ACPX_PROMPT_RETRIES env override", () => {
    withEnv("CLAWPATCH_ACPX_PROMPT_RETRIES", "4", () => {
      const args = buildAcpxJsonArgs("/tmp/repo", null, "read");
      const idx = args.indexOf("--prompt-retries");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("4");
      expect(args).toContain("--approve-reads");
    });
  });

  it("omits --prompt-retries for approve mode", () => {
    withEnv("CLAWPATCH_ACPX_PROMPT_RETRIES", "4", () => {
      const args = buildAcpxJsonArgs("/tmp/repo", null, "approve");
      expect(args).toContain("--approve-all");
      expect(args).not.toContain("--prompt-retries");
    });
  });

  it("omits --prompt-retries when CLAWPATCH_ACPX_PROMPT_RETRIES=0", () => {
    withEnv("CLAWPATCH_ACPX_PROMPT_RETRIES", "0", () => {
      const args = buildAcpxJsonArgs("/tmp/repo", null, "read");
      expect(args).not.toContain("--prompt-retries");
    });
  });

  it("passes through agent and model from parseAcpxAgent", () => {
    delete process.env["CLAWPATCH_ACPX_PROMPT_RETRIES"];
    const args = buildAcpxJsonArgs("/tmp/repo", "gamma:opus", "read");
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe("opus");
    expect(args).toContain("gamma");
  });
});

describe("extractJson reasoning blocks", () => {
  it("prefers the answer after a <think> block that holds unbalanced braces", () => {
    const input =
      '<think>the handler `if (x) {` never closes, and the "main" path is fine</think>\n' +
      '{"outcome":"fixed","reasoning":"ok","commands":[]}';
    expect(extractJson(input)).toEqual({ outcome: "fixed", reasoning: "ok", commands: [] });
  });

  it("prefers the final answer over a draft object inside the reasoning block", () => {
    const input =
      '<think>draft: {"outcome":"draft","reasoning":"x","commands":[]}</think>' +
      '```json\n{"outcome":"fixed","reasoning":"ok","commands":[]}\n```';
    expect(extractJson(input)).toEqual({ outcome: "fixed", reasoning: "ok", commands: [] });
  });

  it("ignores a closing tag that does not follow a leading reasoning block", () => {
    const input = '{"outcome":"fixed","reasoning":"ok","commands":[]}</think> trailing words';
    expect(extractJson(input)).toEqual({ outcome: "fixed", reasoning: "ok", commands: [] });
  });

  // Regression (round-2 review): a valid reply whose string quotes `</think>`
  // and later a `{}` literal must come back whole, not as `{}`.
  it("returns a valid reply whole even when a string quotes </think> and {}", () => {
    const reply = {
      findings: [],
      inspected: {
        files: [],
        symbols: [],
        notes: ["x.split('</think>')[-1] if '</think>' in x else {}"],
      },
    };
    expect(extractJson(JSON.stringify(reply))).toEqual(reply);
  });

  it("keeps a fenced or prose-wrapped reply whole when a string quotes </think> {}", () => {
    const reply = { notes: ["strip it: </think> {} then parse"] };
    expect(extractJson("```json\n" + JSON.stringify(reply) + "\n```")).toEqual(reply);
    expect(extractJson(`Result: ${JSON.stringify(reply)} done`)).toEqual(reply);
  });

  it("ends a leading reasoning block at its first close tag", () => {
    const reply = { notes: ["</think> {}"] };
    expect(extractJson(`<think>plan { draft</think>${JSON.stringify(reply)}`)).toEqual(reply);
  });
});

function chatReply(
  content: string,
  finishReason: string | null = "stop",
  extra: Record<string, unknown> = {},
  message: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: "assistant", content, ...message },
      },
    ],
    ...extra,
  };
}

// Each call to the stubbed fetch answers with the next body (the last one
// repeats). Returns the mock so tests can inspect what was sent.
function stubGateway(...bodies: Array<string | Record<string, unknown>>) {
  const queue = [...bodies];
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const text = typeof next === "string" ? next : JSON.stringify(next);
    return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubGateway>, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

// Like stubGateway, but the reply arrives after `delayMs`, and an abort of the
// request signal rejects the call the way real fetch does.
function stubSlowGateway(delayMs: number, reply: Record<string, unknown>) {
  const fetchMock = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(JSON.stringify(reply), { status: 200 }));
        }, delayMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function gatewayReviewOptions(dir: string | null) {
  return { model: null, reasoningEffort: null, skipGitRepoCheck: false, diagnosticsDir: dir };
}

function capturePathFrom(error: ClawpatchError): string {
  const match = error.message.match(/full response saved to (.+?) — /u);
  if (!match?.[1]) throw new Error(`no capture path in: ${error.message}`);
  return match[1];
}

describe("gateway provider replies", () => {
  const ENV_KEYS = [
    "GATEWAY_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CLAWPATCH_GATEWAY_MODEL",
    "CLAWPATCH_GATEWAY_TIMEOUT_MS",
    "CLAWPATCH_PROVIDER_TIMEOUT_MS",
    "CLAWPATCH_GATEWAY_MAX_TOKENS",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};
  let diagnosticsDir: string;

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
    process.env["GATEWAY_API_KEY"] = "test-secret-key";
    process.env["OPENAI_BASE_URL"] = "https://gateway.test/v1";
    diagnosticsDir = join(await fixtureRoot("clawpatch-gateway-diag-"), "provider-failures");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  const REVIEW_JSON = JSON.stringify({
    findings: [
      {
        title: "repairAddressedTurnEcho leaves authored bubble unstamped when echo is dropped",
        category: "bug",
        severity: "medium",
        confidence: "medium",
        evidence: [{ path: "src/chat.ts", startLine: 10, endLine: 12, symbol: null, quote: null }],
        reasoning: "The echo branch returns before stamping the bubble.",
        reproduction: null,
        recommendation: "Stamp the bubble before returning.",
        whyTestsDoNotAlreadyCoverThis: "No test drops the echo.",
        suggestedRegressionTest: null,
        minimumFixScope: "src/chat.ts",
      },
    ],
    inspected: { files: ["src/chat.ts"], symbols: [], notes: [] },
  });

  async function reviewError(dir: string | null = diagnosticsDir): Promise<ClawpatchError> {
    try {
      await providerByName("gateway").review("/tmp", "review this", gatewayReviewOptions(dir));
    } catch (error: unknown) {
      if (error instanceof ClawpatchError) return error;
      throw error;
    }
    throw new Error("expected the gateway review to fail");
  }

  it("parses a clean structured reply and sends no max_tokens by default", async () => {
    const fetchMock = stubGateway(chatReply(REVIEW_JSON));
    const out = await providerByName("gateway").review(
      "/tmp",
      "review this",
      gatewayReviewOptions(diagnosticsDir),
    );
    expect(out.findings).toHaveLength(1);
    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body["response_format"]).toMatchObject({ type: "json_schema" });
  });

  it("sends the session id as x-litellm-session-id, and omits it when unset", async () => {
    const fetchMock = stubGateway(chatReply(REVIEW_JSON));
    const options = gatewayReviewOptions(diagnosticsDir);
    await providerByName("gateway").review("/tmp", "review this", {
      ...options,
      sessionId: "clawpatch:feat-1",
    });
    await providerByName("gateway").review("/tmp", "review this", options);
    const headers = (call: number) =>
      (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers(0)["x-litellm-session-id"]).toBe("clawpatch:feat-1");
    expect(headers(1)).not.toHaveProperty("x-litellm-session-id");
  });

  it.each([
    ["a json fence", "```json\n" + REVIEW_JSON + "\n```"],
    ["leading and trailing prose", `Here is the review:\n${REVIEW_JSON}\nHope this helps.`],
    ["a <think> block with a stray brace", `<think>if (x) { is unclosed</think>${REVIEW_JSON}`],
  ])("accepts a reply wrapped in %s", async (_label, content) => {
    stubGateway(chatReply(content));
    const out = await providerByName("gateway").review(
      "/tmp",
      "review this",
      gatewayReviewOptions(diagnosticsDir),
    );
    expect(out.findings).toHaveLength(1);
  });

  it("reports a reply cut off at the output limit as a truncation it does not retry", async () => {
    stubGateway(
      chatReply(REVIEW_JSON.slice(0, 180), "length", {
        usage: {
          prompt_tokens: 91234,
          completion_tokens: 32000,
          completion_tokens_details: { reasoning_tokens: 12000 },
        },
      }),
    );
    const error = await reviewError();
    expect(error.exitCode).toBe(4);
    expect(error.code).toBe("provider-failure");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain(" — response truncated at the output limit (");
    expect(error.message).not.toContain("not parseable");
    expect(error.message).toContain("finish_reason=length");
    expect(error.message).toContain("completion_tokens=32000");
    expect(error.message).toContain("reasoning_tokens=12000");
    expect(error.message).toContain("prompt_tokens=91234");
    expect(error.message).toContain("max_tokens=unset");
    // no content excerpt: the failure class must stay inside a short stderr tail
    expect(error.message).not.toContain("tail=");
  });

  it("reports reasoning that consumed the whole output budget as truncation", async () => {
    stubGateway(
      chatReply(
        "",
        "length",
        {
          usage: {
            completion_tokens: 32000,
            completion_tokens_details: { reasoning_tokens: 32000 },
          },
        },
        { reasoning_content: "x".repeat(500) },
      ),
    );
    const error = await reviewError();
    expect(error.message).toContain("response truncated at the output limit");
    expect(error.message).toContain("content_chars=0");
    expect(error.message).toContain("reasoning_chars=500");
    expect(error.retryable).toBe(false);
  });

  it("keeps a complete answer even when finish_reason is length", async () => {
    stubGateway(chatReply(REVIEW_JSON, "length"));
    const out = await providerByName("gateway").review(
      "/tmp",
      "review this",
      gatewayReviewOptions(diagnosticsDir),
    );
    expect(out.findings).toHaveLength(1);
  });

  it("reports broken JSON with finish_reason and saves the full raw response", async () => {
    const broken = `${REVIEW_JSON.slice(0, 150)} ${"filler ".repeat(200)}]]`;
    const reply = chatReply(broken, "stop", { usage: { completion_tokens: 900 } });
    stubGateway(reply);
    const error = await reviewError();
    expect(error.exitCode).toBe(4);
    expect(error.code).toBe("provider-failure");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain(" — response was not parseable JSON (");
    expect(error.message).toContain("finish_reason=stop");
    expect(error.message).toContain(`content_chars=${broken.length}`);
    // the tail shows where the JSON broke, not the uninformative head
    expect(error.message).toContain("tail=…");
    expect(error.message).toContain("filler ]]");

    const capturePath = capturePathFrom(error);
    expect(capturePath.startsWith(diagnosticsDir)).toBe(true);
    const saved = await readFile(capturePath, "utf8");
    const record = JSON.parse(saved) as Record<string, unknown>;
    expect(record["rawBody"]).toBe(JSON.stringify(reply));
    expect(record["label"]).toBe("review");
    expect(record["model"]).toBe("protolabs/smart");
    expect(record["httpStatus"]).toBe(200);
    expect(record["promptChars"]).toBe("review this".length);
    expect(saved).not.toContain("test-secret-key");
  });

  it("does not write a capture when no diagnostics dir is configured", async () => {
    stubGateway(chatReply("definitely not json", "stop"));
    const error = await reviewError(null);
    expect(error.message).toContain("response was not parseable JSON");
    expect(error.message).not.toContain("full response saved to");
    await expect(readdir(diagnosticsDir)).rejects.toThrow();
  });

  it("prunes captures to the newest 20 and leaves unrelated files alone", async () => {
    await mkdir(diagnosticsDir, { recursive: true });
    for (let i = 0; i < 22; i += 1) {
      const name = `20200101T0000000${String(i).padStart(2, "0")}Z-gateway-review-0000000${i % 10}.json`;
      await writeFile(join(diagnosticsDir, name), "{}\n", "utf8");
    }
    await writeFile(join(diagnosticsDir, "notes.txt"), "keep me\n", "utf8");
    stubGateway(chatReply("not json", "stop"));
    const error = await reviewError();
    const entries = await readdir(diagnosticsDir);
    const captures = entries.filter((name) => name.includes("-gateway-"));
    expect(captures).toHaveLength(20);
    expect(entries).toContain("notes.txt");
    expect(captures).toContain(capturePathFrom(error).slice(diagnosticsDir.length + 1));
    expect(captures.some((name) => name.startsWith("20200101T000000000Z"))).toBe(false);
  });

  it("sends max_tokens only when CLAWPATCH_GATEWAY_MAX_TOKENS is a positive integer", async () => {
    process.env["CLAWPATCH_GATEWAY_MAX_TOKENS"] = "48000";
    const fetchMock = stubGateway(chatReply(REVIEW_JSON.slice(0, 50), "length"));
    const error = await reviewError();
    expect(sentBody(fetchMock)["max_tokens"]).toBe(48000);
    expect(error.message).toContain("max_tokens=48000");

    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const garbage of ["", "abc", "0", "-5", "1.5"]) {
      process.env["CLAWPATCH_GATEWAY_MAX_TOKENS"] = garbage;
      // eslint-disable-next-line no-underscore-dangle
      expect(
        gatewayAndProtoTesting.gatewayConfig(gatewayReviewOptions(diagnosticsDir)).maxTokens,
      ).toBeNull();
    }
    write.mockRestore();
  });

  it("treats a 200 body that is not JSON as a retryable provider-failure", async () => {
    stubGateway("<html><body>502 Bad Gateway</body></html>");
    const error = await reviewError();
    expect(error.exitCode).toBe(4);
    expect(error.code).toBe("provider-failure");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain(" — response body was not JSON (");
  });

  it("keeps an API error in the body non-retryable", async () => {
    stubGateway({ error: { message: "model not found" } });
    const error = await reviewError();
    expect(error.exitCode).toBe(4);
    expect(error.code).toBe("provider-failure");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(
      /^gateway review: full response saved to .+ — API error — model not found$/u,
    );
  });

  it("keeps the failure class and facts in the last 400 chars of stderr", async () => {
    // pr-reviewer keeps only the last 400 chars of stderr; a long state-dir
    // path must not push out what failed.
    diagnosticsDir = join(
      await fixtureRoot("clawpatch-gateway-long-"),
      "a".repeat(180),
      "b".repeat(180),
      "provider-failures",
    );
    stubGateway(
      chatReply(REVIEW_JSON.slice(0, 120), "length", {
        usage: { prompt_tokens: 91234, completion_tokens: 32000 },
      }),
    );
    const truncated = await reviewError();
    expect(truncated.message.startsWith("gateway review: full response saved to ")).toBe(true);
    expect(capturePathFrom(truncated).length).toBeGreaterThan(400);
    const truncatedTail = `error: ${truncated.message}`.slice(-400);
    expect(truncatedTail).toContain("response truncated at the output limit");
    expect(truncatedTail).toContain("finish_reason=length");
    expect(truncatedTail).toContain("completion_tokens=32000");

    stubGateway(chatReply(`${REVIEW_JSON.slice(0, 120)} ${"x".repeat(500)}`, "stop"));
    const unparseable = await reviewError();
    const unparseableTail = `error: ${unparseable.message}`.slice(-400);
    expect(unparseableTail).toContain("response was not parseable JSON");
    expect(unparseableTail).toContain("finish_reason=stop");
  });

  it("does not offer a retry when the attempt used more than half the timeout", async () => {
    process.env["CLAWPATCH_GATEWAY_TIMEOUT_MS"] = "400";
    stubSlowGateway(250, chatReply("{ not json", "stop"));
    const error = await reviewError();
    expect(error.message).toContain("response was not parseable JSON");
    expect(error.retryable).toBe(false);
  });

  it("offers a retry for an unparseable reply that came back quickly", async () => {
    process.env["CLAWPATCH_GATEWAY_TIMEOUT_MS"] = "10000";
    stubSlowGateway(10, chatReply("{ not json", "stop"));
    const error = await reviewError();
    expect(error.retryable).toBe(true);
  });

  it("vetoes a retry of a wrong-shape reply that used more than half the timeout", async () => {
    process.env["CLAWPATCH_GATEWAY_TIMEOUT_MS"] = "400";
    stubSlowGateway(250, chatReply(JSON.stringify({ verdict: "looks fine" }), "stop"));
    const slow = await reviewError();
    expect(slow.exitCode).toBe(8);
    expect(slow.code).toBe("malformed-output");
    expect(slow.retryable).toBe(false);

    process.env["CLAWPATCH_GATEWAY_TIMEOUT_MS"] = "10000";
    stubSlowGateway(10, chatReply(JSON.stringify({ verdict: "looks fine" }), "stop"));
    const fast = await reviewError();
    expect(fast.code).toBe("malformed-output");
    // no veto: its code decides, and malformed-output is retried
    expect(fast.retryable).toBeUndefined();
  });

  it("gives a retry only the time left under the call's shared deadline", async () => {
    process.env["CLAWPATCH_GATEWAY_TIMEOUT_MS"] = "300";
    stubSlowGateway(5000, chatReply(REVIEW_JSON));
    const started = Date.now();
    const error = await providerByName("gateway")
      .review("/tmp", "review this", {
        ...gatewayReviewOptions(diagnosticsDir),
        callStartedAt: started - 250,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(ClawpatchError);
    expect((error as ClawpatchError).exitCode).toBe(4);
    expect((error as ClawpatchError).message).toMatch(
      /^gateway review: request failed \(no reply within the \d+ms left of the 300ms gateway timeout\)$/u,
    );
    expect((error as ClawpatchError).deadlineExceeded).toBe(true);
  });

  it("warns once on an invalid CLAWPATCH_GATEWAY_MAX_TOKENS and sends none", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      process.env["CLAWPATCH_GATEWAY_MAX_TOKENS"] = "32k-typo";
      const fetchMock = stubGateway(chatReply(REVIEW_JSON));
      await providerByName("gateway").review("/tmp", "a", gatewayReviewOptions(diagnosticsDir));
      await providerByName("gateway").review("/tmp", "b", gatewayReviewOptions(diagnosticsDir));
      expect(sentBody(fetchMock)).not.toHaveProperty("max_tokens");
      const warnings = write.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("CLAWPATCH_GATEWAY_MAX_TOKENS"));
      expect(warnings).toEqual([
        'warning: ignoring CLAWPATCH_GATEWAY_MAX_TOKENS="32k-typo" (expected a positive integer); no max_tokens is sent\n',
      ]);
    } finally {
      write.mockRestore();
    }
  });
});
