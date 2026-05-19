import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandArgs } from "./exec.js";
import { ClawpatchError } from "./errors.js";
import { pathExists } from "./fs.js";
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
  ReviewOutput,
  RevalidateOutput,
  agentMapOutputSchema,
  fixPlanOutputSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
  type ReasoningEffort,
} from "./types.js";

export { extractJson } from "./provider-json.js";

export type ProviderOptions = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  skipGitRepoCheck: boolean;
};
export type Provider = {
  name: string;
  check(root: string): Promise<string>;
  map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput>;
  review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput>;
  fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput>;
  revalidate(root: string, prompt: string, options: ProviderOptions): Promise<RevalidateOutput>;
};

export function providerByName(name: string): Provider {
  if (name === "codex") {
    return codexProvider;
  }
  if (name === "gemini") {
    return geminiProvider;
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
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runCodexJson(root, prompt, options, reviewJsonSchema);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runCodexJson(root, prompt, options, fixPlanJsonSchema, "workspace-write");
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runCodexJson(root, prompt, options, revalidateJsonSchema);
    return revalidateOutputSchema.parse(output);
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
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, reviewJsonSchema, true);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, fixPlanJsonSchema, false);
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, revalidateJsonSchema, true);
    return revalidateOutputSchema.parse(output);
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
    const output = await runAcpxJson(root, prompt, options.model, agentMapJsonSchema, "read");
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runAcpxJson(root, prompt, options.model, reviewJsonSchema, "read");
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runAcpxJson(root, prompt, options.model, fixPlanJsonSchema, "approve");
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runAcpxJson(root, prompt, options.model, revalidateJsonSchema, "read");
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
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runGrokJson(root, prompt, options.model, agentMapJsonSchema, true);
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runGrokJson(root, prompt, options.model, reviewJsonSchema, true);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runGrokJson(root, prompt, options.model, fixPlanJsonSchema, false);
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runGrokJson(root, prompt, options.model, revalidateJsonSchema, true);
    return revalidateOutputSchema.parse(output);
  },
};

const PI_DEFAULT_TIMEOUT_MS = 180_000;
const GEMINI_DEFAULT_TIMEOUT_MS = 180_000;
const GEMINI_PATCHED_STABLE = "0.39.1";
const GEMINI_PATCHED_PREVIEW = "0.40.0-preview.3";

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
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runPiJson(root, prompt, options, reviewJsonSchema, true);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runPiJson(root, prompt, options, fixPlanJsonSchema, false);
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runPiJson(root, prompt, options, revalidateJsonSchema, true);
    return revalidateOutputSchema.parse(output);
  },
};

const geminiProvider: Provider = {
  name: "gemini",
  async check(root: string): Promise<string> {
    const result = await runGeminiCommand(root, ["--version"]);
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        geminiFailureMessage(result.stdout, result.stderr),
        providerExitCode(`${result.stderr}\n${result.stdout}`),
        "provider-auth",
      );
    }
    const version = result.stdout.trim() || result.stderr.trim();
    assertGeminiPatched(version);
    return `${version} (patched for GHSA-wpqr-6v78-jr5g)`;
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runGeminiJson(root, prompt, options, agentMapJsonSchema, "plan");
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runGeminiJson(root, prompt, options, reviewJsonSchema, "plan");
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runGeminiJson(root, prompt, options, fixPlanJsonSchema, "auto_edit");
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runGeminiJson(root, prompt, options, revalidateJsonSchema, "plan");
    return revalidateOutputSchema.parse(output);
  },
};

async function runGeminiJson(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  approvalMode: "plan" | "auto_edit",
): Promise<unknown> {
  requireGeminiTrustedWorkspace();
  const args = geminiArgs(options, approvalMode);
  const result = await runGeminiCommand(
    root,
    args,
    geminiPrompt(prompt, schema, approvalMode === "plan"),
  );
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      geminiFailureMessage(result.stdout, result.stderr),
      providerExitCode(`${result.stderr}\n${result.stdout}`),
      "provider-failure",
    );
  }
  const response = extractGeminiResponse(result.stdout);
  const parsed = extractJson(response);
  if (parsed === null) {
    throw new ClawpatchError(
      `gemini provider response contained no parseable Clawpatch JSON ` +
        `(response preview: ${safeProviderPreview(response)})`,
      8,
      "malformed-output",
    );
  }
  return parsed;
}

function geminiArgs(options: ProviderOptions, approvalMode: "plan" | "auto_edit"): string[] {
  const args = [
    "--skip-trust",
    "-p",
    "",
    `--approval-mode=${approvalMode}`,
    "--output-format=json",
    "--extensions",
    "none",
  ];
  if (options.model !== null) {
    args.push("--model", options.model);
  }
  return args;
}

async function runGeminiCommand(root: string, args: string[], input?: string) {
  const isolated = await geminiIsolatedEnv();
  try {
    return await runCommandArgs(geminiExecutable(), args, root, input, {
      trimOutput: false,
      timeoutMs: geminiTimeoutMs(),
      env: isolated.env,
      inheritEnv: false,
    });
  } finally {
    await rm(isolated.root, { recursive: true, force: true }).catch(() => {});
  }
}

function geminiExecutable(): string {
  const configured = process.env["CLAWPATCH_GEMINI_BIN"]?.trim();
  if (configured === undefined || configured.length === 0) {
    return "gemini";
  }
  if (configured.includes("\0")) {
    throw new ClawpatchError("invalid CLAWPATCH_GEMINI_BIN", 2, "invalid-usage");
  }
  return configured;
}

async function geminiIsolatedEnv(): Promise<{ env: NodeJS.ProcessEnv; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "clawpatch-gemini-"));
  const home = join(root, "home");
  const xdgConfig = join(root, "xdg-config");
  const xdgCache = join(root, "xdg-cache");
  const xdgData = join(root, "xdg-data");
  await Promise.all([
    mkdir(join(home, ".gemini"), { recursive: true }),
    mkdir(xdgConfig, { recursive: true }),
    mkdir(xdgCache, { recursive: true }),
    mkdir(xdgData, { recursive: true }),
  ]);
  await seedGeminiState(home);
  return {
    root,
    env: geminiEnv({
      home,
      xdgConfig,
      xdgCache,
      xdgData,
    }),
  };
}

async function seedGeminiState(home: string): Promise<void> {
  const sourceHome = process.env["HOME"];
  if (sourceHome === undefined || sourceHome.length === 0) {
    return;
  }
  const sourceDir = join(sourceHome, ".gemini");
  const targetDir = join(home, ".gemini");
  for (const file of ["google_accounts.json", "oauth_creds.json", "installation_id"]) {
    const source = join(sourceDir, file);
    if (await pathExists(source)) {
      await copyFile(source, join(targetDir, file));
    }
  }
  await writeMinimalGeminiSettings(sourceDir, targetDir);
}

async function writeMinimalGeminiSettings(sourceDir: string, targetDir: string): Promise<void> {
  const source = join(sourceDir, "settings.json");
  if (!(await pathExists(source))) {
    return;
  }
  let raw: string;
  try {
    raw = await readFile(source, "utf8");
  } catch {
    return;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  const selectedType = geminiSelectedAuthType(settings);
  if (selectedType === null) {
    return;
  }
  await writeFile(
    join(targetDir, "settings.json"),
    JSON.stringify({ security: { auth: { selectedType } } }),
    "utf8",
  );
}

function geminiSelectedAuthType(settings: unknown): string | null {
  if (typeof settings !== "object" || settings === null) {
    return null;
  }
  const security = (settings as Record<string, unknown>)["security"];
  if (typeof security !== "object" || security === null) {
    return null;
  }
  const auth = (security as Record<string, unknown>)["auth"];
  if (typeof auth !== "object" || auth === null) {
    return null;
  }
  const selectedType = (auth as Record<string, unknown>)["selectedType"];
  return typeof selectedType === "string" && selectedType.length > 0 ? selectedType : null;
}

function geminiEnv(paths?: {
  home: string;
  xdgConfig: string;
  xdgCache: string;
  xdgData: string;
}): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "TMPDIR",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "NO_COLOR",
  ];
  const env: NodeJS.ProcessEnv = {};
  if (paths !== undefined) {
    env["HOME"] = paths.home;
    env["XDG_CONFIG_HOME"] = paths.xdgConfig;
    env["XDG_CACHE_HOME"] = paths.xdgCache;
    env["XDG_DATA_HOME"] = paths.xdgData;
  }
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (process.platform === "win32") {
    for (const key of ["ComSpec", "SystemRoot", "WINDIR", "PATHEXT"]) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }
  return env;
}

function geminiPrompt(prompt: string, schema: object, readOnly: boolean): string {
  const promptBody = readOnly
    ? "READ-ONLY REVIEW MODE.\n" +
      "Do not modify, create, or delete any files in the workspace.\n" +
      "Do not run shell commands, use network tools, use MCP servers, activate skills, or launch subagents.\n" +
      "Do not exit plan mode. Only inspect files needed to answer with the JSON output below.\n\n" +
      prompt
    : prompt;
  return `${promptBody}

Provider output schema:
${JSON.stringify(schema, null, 2)}

Return only one JSON object matching the schema.`;
}

function extractGeminiResponse(stdout: string): string {
  const text = stdout.trim();
  if (text.length === 0) {
    throw new ClawpatchError("gemini provider produced no output", 8, "malformed-output");
  }
  const envelope = parseGeminiEnvelope(text);
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new ClawpatchError(
      "gemini provider produced a non-object JSON envelope",
      8,
      "malformed-output",
    );
  }
  const record = envelope as Record<string, unknown>;
  const error = record["error"];
  if (error !== undefined && error !== null) {
    throw new ClawpatchError(
      `gemini provider error: ${safeProviderPreview(geminiErrorText(error))}`,
      providerExitCode(geminiErrorText(error)),
      "provider-failure",
    );
  }
  if (typeof record["response"] !== "string") {
    throw new ClawpatchError(
      "gemini provider JSON envelope is missing string field `response`",
      8,
      "malformed-output",
    );
  }
  return record["response"];
}

function parseGeminiEnvelope(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {}
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      values.push(JSON.parse(trimmed) as unknown);
    } catch {
      throw new ClawpatchError(
        `gemini provider produced malformed JSON envelope ` +
          `(output preview: ${safeProviderPreview(text)})`,
        8,
        "malformed-output",
      );
    }
  }
  if (values.length === 1) {
    return values[0];
  }
  throw new ClawpatchError(
    `gemini provider produced ${values.length} JSON envelopes; expected exactly one`,
    8,
    "malformed-output",
  );
}

function geminiErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  const record = error as Record<string, unknown>;
  for (const key of ["message", "status", "code"]) {
    if (typeof record[key] === "string" || typeof record[key] === "number") {
      return String(record[key]);
    }
  }
  return JSON.stringify(record);
}

function geminiFailureMessage(stdout: string, stderr: string): string {
  const output = stderr.trim().length > 0 ? stderr : stdout;
  const preview = safeProviderPreview(output);
  return preview.length === 0 ? "gemini provider failed" : `gemini provider failed: ${preview}`;
}

function assertGeminiPatched(versionText: string): void {
  if (process.env["CLAWPATCH_GEMINI_ALLOW_UNPATCHED"] === "1") {
    process.stderr.write(
      "warning: CLAWPATCH_GEMINI_ALLOW_UNPATCHED=1 bypasses the Gemini CLI " +
        "security version gate for GHSA-wpqr-6v78-jr5g; use only for local diagnostics.\n",
    );
    return;
  }
  const version = parseGeminiVersion(versionText);
  if (version === null || !isGeminiPatched(version)) {
    throw new ClawpatchError(
      `gemini CLI version ${versionText || "unknown"} is not in the patched range for ` +
        `GHSA-wpqr-6v78-jr5g; install @google/gemini-cli >=${GEMINI_PATCHED_STABLE} ` +
        `or >=${GEMINI_PATCHED_PREVIEW}`,
      4,
      "provider-auth",
    );
  }
}

function parseGeminiVersion(versionText: string): string | null {
  return versionText.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u)?.[0] ?? null;
}

function isGeminiPatched(version: string): boolean {
  if (version.includes("-preview.")) {
    return compareGeminiVersions(version, GEMINI_PATCHED_PREVIEW) >= 0;
  }
  return compareGeminiVersions(version, GEMINI_PATCHED_STABLE) >= 0;
}

function compareGeminiVersions(left: string, right: string): number {
  const a = geminiVersionParts(left);
  const b = geminiVersionParts(right);
  for (let index = 0; index < 4; index += 1) {
    const diff = a[index]! - b[index]!;
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function geminiVersionParts(version: string): [number, number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?/u);
  if (match === null) {
    return [0, 0, 0, 0];
  }
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4]),
  ];
}

function requireGeminiTrustedWorkspace(): void {
  if (process.env["CLAWPATCH_GEMINI_TRUST_WORKSPACE"] === "true") {
    return;
  }
  throw new ClawpatchError(
    "gemini provider requires CLAWPATCH_GEMINI_TRUST_WORKSPACE=true because it runs Gemini CLI with --skip-trust; use only in an isolated trusted checkout",
    2,
    "invalid-usage",
  );
}

function geminiTimeoutMs(): number {
  const raw =
    process.env["CLAWPATCH_GEMINI_TIMEOUT_MS"] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  if (raw === undefined) {
    return GEMINI_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : GEMINI_DEFAULT_TIMEOUT_MS;
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
  async review(_root: string, prompt: string): Promise<ReviewOutput> {
    if (!prompt.includes("TODO_BUG") && !prompt.includes("BUG:")) {
      return { findings: [], inspected: { files: [], symbols: [], notes: ["mock clean"] } };
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

async function runAcpxJson(
  root: string,
  prompt: string,
  model: string | null,
  schema: object,
  permission: "read" | "approve",
): Promise<unknown> {
  const { agent, agentModel } = parseAcpxAgent(model);
  const permFlag = permission === "read" ? "--approve-reads" : "--approve-all";
  const args = ["--cwd", root, permFlag, "--format", "json", "--json-strict", "--suppress-reads"];
  if (agentModel !== null) {
    args.push("--model", agentModel);
  }
  args.push(agent, "exec", "--file", "-");
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
  return extractAcpxJson(result.stdout);
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
  const candidates = [
    ...(messageChunks.length > 0 ? [messageChunks.join("")] : []),
    ...toolCandidates.toReversed(),
    ...(thoughtChunks.length > 0 ? [thoughtChunks.join("")] : []),
  ];
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
        return parsed;
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

// eslint-disable-next-line no-underscore-dangle
export const __testing = {
  acpxFailureMessage,
  addCodexModelArgs,
  addCodexSandboxArgs,
  codexFailureMessage,
  extractAcpxJson,
  extractGeminiResponse,
  geminiIsolatedEnv,
  geminiSelectedAuthType,
  extractOpencodeJson,
  geminiArgs,
  geminiEnv,
  geminiPrompt,
  assertGeminiPatched,
  isGeminiPatched,
  parseAcpxAgent,
  parseCodexJson,
  parseGeminiVersion,
  piThinkingLevel,
  providerJsonSchema,
};
