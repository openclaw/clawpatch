import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandArgs } from "../exec.js";
import { ClawpatchError } from "../errors.js";
import { providerExitCode } from "../provider-errors.js";
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

const DEVIN_DEFAULT_TIMEOUT_MS = 300_000;

// Devin CLI permission modes (verified against `devin --help`, v3000.2.17):
//   auto         — auto-approves read-only tools only; prompts for writes (print mode never
//                  grants, so this is effective read-only enforcement for review/revalidate)
//   accept-edits — auto-approves workspace edits in addition to read-only tools (used for fix)
const DEVIN_READ_PERMISSION_MODE = "auto";
const DEVIN_WRITE_PERMISSION_MODE = "accept-edits";

export const devinProvider: Provider = {
  name: "devin",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("devin", ["--version"], root, undefined, {
      timeoutMs: providerCheckTimeoutMs(),
    });
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        "devin CLI not available. Install from https://docs.devin.ai/cli",
        4,
        "provider-auth",
      );
    }
    return result.stdout.trim() || result.stderr.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runDevinJson(root, prompt, options, agentMapJsonSchema, true);
    return parseOrThrow(agentMapOutputSchema, output, "devin agent-map");
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    const output = await runDevinJson(root, prompt, options, reviewJsonSchema, true);
    return parseReviewOutput(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runDevinJson(root, prompt, options, fixPlanJsonSchema, false);
    return parseOrThrow(fixPlanOutputSchema, output, "devin fix-plan");
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runDevinJson(root, prompt, options, revalidateJsonSchema, true);
    return parseOrThrow(revalidateOutputSchema, output, "devin revalidate");
  },
};

async function runDevinJson(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-devin-"));
  const promptPath = join(dir, "prompt.txt");
  try {
    await writeFile(promptPath, devinPrompt(prompt, schema, options.reasoningEffort), "utf8");
    const args = [
      "--print",
      "--prompt-file",
      promptPath,
      "--permission-mode",
      readOnly ? DEVIN_READ_PERMISSION_MODE : DEVIN_WRITE_PERMISSION_MODE,
    ];
    if (options.model !== null) {
      args.push("--model", options.model);
    }
    const result = await runCommandArgs("devin", args, root, undefined, {
      trimOutput: false,
      timeoutMs: devinTimeoutMs(),
    });
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        devinFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stdout, result.stderr),
        "provider-failure",
      );
    }
    const json = extractJson(result.stdout);
    if (json === null) {
      throw new ClawpatchError(
        `devin provider produced unparseable JSON output (preview: ${safeProviderPreview(result.stdout)})`,
        8,
        "malformed-output",
      );
    }
    return json;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function devinPrompt(prompt: string, schema: object, reasoningEffort: string | null): string {
  const effortPreamble =
    reasoningEffort !== null && reasoningEffort !== "none"
      ? `REASONING EFFORT: ${reasoningEffort.toUpperCase()}\n` +
        `Apply ${reasoningEffort} reasoning depth to this review. ` +
        `At "high" or "xhigh", exhaustively analyze every file, trace data flows, ` +
        `and consider edge cases that lower-effort passes would miss.\n\n`
      : "";
  return (
    `${effortPreamble}${prompt}\n\n` +
    "Return ONLY a JSON object matching this schema. No prose preamble, no markdown fences, " +
    "no thinking-out-loud text before the JSON. " +
    `Schema:\n${JSON.stringify(schema)}\n`
  );
}

function devinFailureMessage(stdout: string, stderr: string): string {
  const stderrPreview = safeProviderPreview(stderr);
  if (stderrPreview.length > 0) {
    return `devin provider failed: ${stderrPreview}`;
  }
  const stdoutPreview = safeProviderPreview(stdout);
  if (stdoutPreview.length > 0) {
    return `devin provider failed: ${stdoutPreview}`;
  }
  return "devin provider failed";
}

function devinTimeoutMs(): number {
  return providerTimeoutMs("CLAWPATCH_DEVIN_TIMEOUT_MS", DEVIN_DEFAULT_TIMEOUT_MS);
}

export const devinTesting = {
  devinFailureMessage,
  devinPrompt,
  devinTimeoutMs,
};
