import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandArgs } from "./exec.js";
import { ClawpatchError } from "./errors.js";
import {
  FixPlanOutput,
  ReviewOutput,
  RevalidateOutput,
  fixPlanOutputSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
} from "./types.js";

export type Provider = {
  name: string;
  check(root: string): Promise<string>;
  review(root: string, prompt: string, model: string | null): Promise<ReviewOutput>;
  fix(root: string, prompt: string, model: string | null): Promise<FixPlanOutput>;
  revalidate(root: string, prompt: string, model: string | null): Promise<RevalidateOutput>;
};

export function providerByName(name: string): Provider {
  if (name === "codex") {
    return codexProvider;
  }
  if (name === "grok") {
    return grokProvider;
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
  async review(root: string, prompt: string, model: string | null): Promise<ReviewOutput> {
    const output = await runCodexJson(root, prompt, model, reviewJsonSchema);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
    const output = await runCodexJson(root, prompt, model, fixPlanJsonSchema, "workspace-write");
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(root: string, prompt: string, model: string | null): Promise<RevalidateOutput> {
    const output = await runCodexJson(root, prompt, model, revalidateJsonSchema);
    return revalidateOutputSchema.parse(output);
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
  async review(root: string, prompt: string, model: string | null): Promise<ReviewOutput> {
    const output = await runGrokJson(root, prompt, model, reviewJsonSchema, true);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
    const output = await runGrokJson(root, prompt, model, fixPlanJsonSchema, false);
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(root: string, prompt: string, model: string | null): Promise<RevalidateOutput> {
    const output = await runGrokJson(root, prompt, model, revalidateJsonSchema, true);
    return revalidateOutputSchema.parse(output);
  },
};

const mockProvider: Provider = {
  name: "mock",
  async check(): Promise<string> {
    return "mock";
  },
  async review(_root: string, prompt: string): Promise<ReviewOutput> {
    if (!prompt.includes("TODO_BUG") && !prompt.includes("BUG:")) {
      return { findings: [], inspected: { files: [], symbols: [], notes: ["mock clean"] } };
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
              path: "src/index.ts",
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
      inspected: { files: ["src/index.ts"], symbols: [], notes: ["mock finding"] },
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

const mockFailProvider: Provider = {
  name: "mock-fail",
  async check(): Promise<string> {
    return "mock-fail";
  },
  async review(): Promise<ReviewOutput> {
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
  model: string | null,
  schema: object,
  sandbox = "read-only",
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-codex-"));
  const schemaPath = join(dir, "schema.json");
  const outputPath = join(dir, "output.json");
  await writeFile(schemaPath, JSON.stringify(schema), "utf8");
  const args = [
    "exec",
    "--cd",
    root,
    "--sandbox",
    sandbox,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
  ];
  if (model !== null) {
    args.push("--model", model);
  }
  args.push("-");
  const result = await runCommandArgs("codex", args, root, prompt);
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      `codex provider failed: ${result.stderr || result.stdout}`,
      providerExitCode(result.stderr),
      "provider-failure",
    );
  }
  const raw = await readFile(outputPath, "utf8").catch(() => "");
  if (raw.trim().length === 0) {
    throw new ClawpatchError("codex provider produced no JSON output", 8, "malformed-output");
  }
  return JSON.parse(raw) as unknown;
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

export function extractJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {}
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fenceMatch && fenceMatch[1]) {
    const candidate = fenceMatch[1].trim();
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  const firstBrace = text.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < text.length; i += 1) {
      const ch = text[i];
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
      if (!inString) {
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            const candidate = text.slice(firstBrace, i + 1);
            try {
              return JSON.parse(candidate);
            } catch {
              return null;
            }
          }
        }
      }
    }
  }
  return null;
}

function providerExitCode(stderr: string): number {
  if (/auth|login|api key/iu.test(stderr)) {
    return 4;
  }
  if (/quota|rate.?limit/iu.test(stderr)) {
    return 5;
  }
  return 1;
}

const reviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "inspected"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "category",
          "severity",
          "confidence",
          "evidence",
          "reasoning",
          "reproduction",
          "recommendation",
          "whyTestsDoNotAlreadyCoverThis",
          "suggestedRegressionTest",
          "minimumFixScope",
        ],
        properties: {
          title: { type: "string" },
          category: {
            enum: [
              "bug",
              "security",
              "performance",
              "concurrency",
              "api-contract",
              "data-loss",
              "test-gap",
              "docs-gap",
              "build-release",
              "maintainability",
            ],
          },
          severity: { enum: ["critical", "high", "medium", "low"] },
          confidence: { enum: ["high", "medium", "low"] },
          evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
          reasoning: { type: "string" },
          reproduction: { anyOf: [{ type: "string" }, { type: "null" }] },
          recommendation: { type: "string" },
          whyTestsDoNotAlreadyCoverThis: { type: "string" },
          suggestedRegressionTest: { anyOf: [{ type: "string" }, { type: "null" }] },
          minimumFixScope: { type: "string" },
        },
      },
    },
    inspected: {
      type: "object",
      additionalProperties: false,
      required: ["files", "symbols", "notes"],
      properties: {
        files: { type: "array", items: { type: "string" } },
        symbols: { type: "array", items: { type: "string" } },
        notes: { type: "array", items: { type: "string" } },
      },
    },
  },
  $defs: {
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["path", "startLine", "endLine", "symbol", "quote"],
      properties: {
        path: { type: "string" },
        startLine: { anyOf: [{ type: "integer" }, { type: "null" }] },
        endLine: { anyOf: [{ type: "integer" }, { type: "null" }] },
        symbol: { anyOf: [{ type: "string" }, { type: "null" }] },
        quote: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  },
};

const revalidateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "reasoning", "commands"],
  properties: {
    outcome: { enum: ["fixed", "open", "false-positive", "uncertain"] },
    reasoning: { type: "string" },
    commands: { type: "array", items: { type: "string" } },
  },
};

const fixPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findingIds", "plannedFiles", "risk", "steps", "validationCommands"],
  properties: {
    summary: { type: "string" },
    findingIds: { type: "array", items: { type: "string" } },
    plannedFiles: { type: "array", items: { type: "string" } },
    risk: { enum: ["low", "medium", "high"] },
    steps: { type: "array", items: { type: "string" } },
    validationCommands: { type: "array", items: { type: "string" } },
  },
};
