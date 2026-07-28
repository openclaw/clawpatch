#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  cleanLocksCommand,
  ciCommand,
  doctorCommand,
  fixCommand,
  initCommand,
  makeContext,
  mapCommand,
  reportCommand,
  revalidateCommand,
  reviewCommand,
  nextCommand,
  openPrCommand,
  showCommand,
  statusCommand,
  triageCommand,
} from "./app.js";
import { ClawpatchError } from "./errors.js";
import { GlobalOptions } from "./config.js";

const moduleRequire = createRequire(import.meta.url);

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp(parsed.command);
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  const context = await makeContext(parsed.global);
  const result = await dispatch(context, parsed.command, parsed.flags);
  writeResult(result, parsed.global);
}

async function dispatch(
  context: Awaited<ReturnType<typeof makeContext>>,
  command: string,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  if (!isKnownCommand(command)) {
    throw new ClawpatchError(`unknown command: ${command}`, 2, "invalid-usage");
  }
  return commandSpecs[command].run(context, flags);
}

type ParsedArgs = {
  command: string;
  flags: Record<string, string | boolean>;
  global: GlobalOptions;
  help: boolean;
  version: boolean;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const global: GlobalOptions = {
    json: false,
    plain: false,
    quiet: false,
    verbose: false,
    debug: false,
    noColor: false,
    noInput: false,
  };
  const flags: Record<string, string | boolean> = {};
  let command = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (command === "" && !arg.startsWith("-")) {
      command = arg;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return { command, flags, global, help: true, version: false };
    }
    if (arg === "--version") {
      return { command, flags, global, help: false, version: true };
    }
    const longName = arg.startsWith("--") ? arg.slice(2) : "";
    const longOption = optionSpecs[longName];
    if (longOption?.kind === "value") {
      const next = readFlagValue(argv, index, arg);
      index += 1;
      setOption(global, flags, longOption, next);
      continue;
    }
    if (longOption?.kind === "boolean") {
      setOption(global, flags, longOption, true);
      continue;
    }
    const shortOption = shortOptionSpecs[arg];
    if (shortOption !== undefined) {
      const value = shortOption.kind === "value" ? readFlagValue(argv, index, arg) : true;
      if (shortOption.kind === "value") {
        index += 1;
      }
      setOption(global, flags, shortOption, value);
      continue;
    }
    throw new ClawpatchError(`unknown arg: ${arg}`, 2, "invalid-usage");
  }
  if (command === "") {
    command = "status";
  }
  validateCommandFlags(command, flags);
  validateCommandRequirements(command, flags);
  return { command, flags, global, help: false, version: false };
}

type Flags = Record<string, string | boolean>;
type CommandContext = Awaited<ReturnType<typeof makeContext>>;
type CommandSpec = {
  flags: readonly string[];
  usage: readonly string[];
  required?: readonly string[];
  helpOverrides?: Readonly<Record<string, string>>;
  globalHelp?: readonly string[];
  validate?: (flags: Flags) => void;
  run: (context: CommandContext, flags: Flags) => Promise<unknown>;
};

const commandSpecs = {
  init: { flags: ["force"], usage: ["clawpatch init [flags]"], run: initCommand },
  map: {
    flags: ["dryRun", "source", "provider", "model", "reasoningEffort", "skipGitRepoCheck"],
    usage: ["clawpatch map [flags]"],
    run: mapCommand,
  },
  status: { flags: [], usage: ["clawpatch status [flags]"], run: statusCommand },
  review: {
    flags: [
      "feature",
      "featureList",
      "project",
      "limit",
      "since",
      "jobs",
      "mode",
      "rateLimitPerMinute",
      "provider",
      "model",
      "reasoningEffort",
      "skipGitRepoCheck",
      "dryRun",
      "promptFile",
      "exportTribunalLedger",
      "includeDirty",
      "noRegistryVerify",
    ],
    usage: ["clawpatch review [flags]"],
    globalHelp: ["json", "quiet"],
    validate: validateReviewFlags,
    run: reviewCommand,
  },
  ci: {
    flags: [
      "limit",
      "since",
      "jobs",
      "rateLimitPerMinute",
      "provider",
      "model",
      "reasoningEffort",
      "skipGitRepoCheck",
      "output",
      "includeDirty",
      "noRegistryVerify",
    ],
    usage: ["clawpatch ci [flags]"],
    helpOverrides: {
      noRegistryVerify: "  --no-registry-verify    see clawpatch review --help for details",
    },
    run: ciCommand,
  },
  report: {
    flags: ["status", "severity", "feature", "project", "category", "triage", "output"],
    usage: ["clawpatch report [flags]"],
    run: reportCommand,
  },
  show: {
    flags: ["finding"],
    usage: ["clawpatch show --finding <id> [flags]"],
    required: ["finding"],
    run: showCommand,
  },
  next: {
    flags: ["status", "project"],
    usage: ["clawpatch next [flags]"],
    helpOverrides: { status: "  --status <status>  default: open" },
    run: nextCommand,
  },
  triage: {
    flags: ["finding", "status", "note"],
    usage: ["clawpatch triage --finding <id> --status <status> [flags]"],
    required: ["finding", "status"],
    helpOverrides: {
      status: "  --status <open|false-positive|fixed|wont-fix|uncertain>",
    },
    run: triageCommand,
  },
  fix: {
    flags: ["finding", "provider", "model", "reasoningEffort", "skipGitRepoCheck", "dryRun"],
    usage: ["clawpatch fix --finding <id> [flags]"],
    required: ["finding"],
    run: fixCommand,
  },
  "open-pr": {
    flags: ["patch", "base", "branch", "title", "draft", "dryRun", "force"],
    usage: ["clawpatch open-pr --patch <id> [flags]"],
    required: ["patch"],
    run: openPrCommand,
  },
  revalidate: {
    flags: [
      "finding",
      "all",
      "status",
      "severity",
      "feature",
      "category",
      "triage",
      "limit",
      "since",
      "provider",
      "model",
      "reasoningEffort",
      "skipGitRepoCheck",
      "includeDirty",
    ],
    usage: [
      "clawpatch revalidate --finding <id> [flags]",
      "clawpatch revalidate --since <ref> [flags]",
    ],
    validate: validateRevalidateFlags,
    run: revalidateCommand,
  },
  doctor: {
    flags: ["provider", "model", "reasoningEffort"],
    usage: ["clawpatch doctor [flags]"],
    run: doctorCommand,
  },
  "clean-locks": {
    flags: ["staleOnly"],
    usage: ["clawpatch clean-locks [flags]"],
    run: cleanLocksCommand,
  },
} satisfies Record<string, CommandSpec>;

type OptionSpec = {
  name: string;
  kind: "value" | "boolean";
  target: "global" | "command";
  help: string;
};

const optionSpecs: Record<string, OptionSpec> = {
  root: { name: "root", kind: "value", target: "global", help: "  --root <path>" },
  "state-dir": {
    name: "stateDir",
    kind: "value",
    target: "global",
    help: "  --state-dir <path>",
  },
  config: { name: "config", kind: "value", target: "global", help: "  --config <path>" },
  json: { name: "json", kind: "boolean", target: "global", help: "  --json" },
  plain: { name: "plain", kind: "boolean", target: "global", help: "  --plain" },
  quiet: { name: "quiet", kind: "boolean", target: "global", help: "  -q, --quiet" },
  verbose: { name: "verbose", kind: "boolean", target: "global", help: "  -v, --verbose" },
  debug: { name: "debug", kind: "boolean", target: "global", help: "  --debug" },
  "no-color": {
    name: "noColor",
    kind: "boolean",
    target: "global",
    help: "  --no-color",
  },
  "no-input": {
    name: "noInput",
    kind: "boolean",
    target: "global",
    help: "  --no-input",
  },
  feature: { name: "feature", kind: "value", target: "command", help: "  --feature <id>" },
  "feature-list": {
    name: "featureList",
    kind: "value",
    target: "command",
    help: "  --feature-list <path>",
  },
  finding: { name: "finding", kind: "value", target: "command", help: "  --finding <id>" },
  limit: { name: "limit", kind: "value", target: "command", help: "  --limit <n>" },
  since: { name: "since", kind: "value", target: "command", help: "  --since <ref>" },
  jobs: {
    name: "jobs",
    kind: "value",
    target: "command",
    help: "  --jobs <n>        default: ~half of CPU cores, max 10",
  },
  mode: {
    name: "mode",
    kind: "value",
    target: "command",
    help: "  --mode <default|deslopify>",
  },
  "rate-limit-per-minute": {
    name: "rateLimitPerMinute",
    kind: "value",
    target: "command",
    help: "  --rate-limit-per-minute <n>   cap provider calls per 60s window (env: CLAWPATCH_RPM)",
  },
  source: {
    name: "source",
    kind: "value",
    target: "command",
    help: "  --source <heuristic|auto|agent>",
  },
  provider: {
    name: "provider",
    kind: "value",
    target: "command",
    help: "  --provider <name>",
  },
  model: { name: "model", kind: "value", target: "command", help: "  --model <name>" },
  "reasoning-effort": {
    name: "reasoningEffort",
    kind: "value",
    target: "command",
    help: "  --reasoning-effort <none|minimal|low|medium|high|xhigh>",
  },
  "prompt-file": {
    name: "promptFile",
    kind: "value",
    target: "command",
    help: '  --prompt-file <path>    appends extra reviewer guidance to the prompt;\n                          use "-" to read from stdin',
  },
  "export-tribunal-ledger": {
    name: "exportTribunalLedger",
    kind: "value",
    target: "command",
    help: "  --export-tribunal-ledger <path>\n                          after the review completes, emit a single\n                          JSONL file with one line per finding shaped\n                          for downstream Tribunal-style signed-ledger\n                          ingest. Opt-in; no effect when omitted.",
  },
  output: { name: "output", kind: "value", target: "command", help: "  --output <path>" },
  status: { name: "status", kind: "value", target: "command", help: "  --status <status>" },
  severity: {
    name: "severity",
    kind: "value",
    target: "command",
    help: "  --severity <severity>",
  },
  category: {
    name: "category",
    kind: "value",
    target: "command",
    help: "  --category <category>",
  },
  triage: { name: "triage", kind: "value", target: "command", help: "  --triage <triage>" },
  project: {
    name: "project",
    kind: "value",
    target: "command",
    help: "  --project <name-or-root>",
  },
  note: { name: "note", kind: "value", target: "command", help: "  --note <text>" },
  patch: { name: "patch", kind: "value", target: "command", help: "  --patch <id>" },
  base: { name: "base", kind: "value", target: "command", help: "  --base <branch>" },
  branch: { name: "branch", kind: "value", target: "command", help: "  --branch <branch>" },
  title: { name: "title", kind: "value", target: "command", help: "  --title <title>" },
  "dry-run": { name: "dryRun", kind: "boolean", target: "command", help: "  --dry-run" },
  "skip-git-repo-check": {
    name: "skipGitRepoCheck",
    kind: "boolean",
    target: "command",
    help: "  --skip-git-repo-check",
  },
  force: { name: "force", kind: "boolean", target: "command", help: "  --force" },
  all: { name: "all", kind: "boolean", target: "command", help: "  --all" },
  draft: { name: "draft", kind: "boolean", target: "command", help: "  --draft" },
  "stale-only": {
    name: "staleOnly",
    kind: "boolean",
    target: "command",
    help: "  --stale-only",
  },
  "include-dirty": {
    name: "includeDirty",
    kind: "boolean",
    target: "command",
    help: "  --include-dirty",
  },
  "no-registry-verify": {
    name: "noRegistryVerify",
    kind: "boolean",
    target: "command",
    help: '  --no-registry-verify    disable a configured npm-registry post-validator that\n                          drops findings whose "package X@Y is\n                          unpublished" claim is refuted by the registry.\n                          Set registryVerifier.enabled=true in config.json\n                          to opt in; this flag disables it for one run.',
  },
};

const optionSpecsByName = new Map(
  Object.values(optionSpecs).map((option) => [option.name, option] as const),
);

const shortOptionSpecs: Record<string, OptionSpec> = {
  "-q": optionSpecs["quiet"]!,
  "-v": optionSpecs["verbose"]!,
  "-o": optionSpecs["output"]!,
};

const shortFlagNames = new Set(["-h", ...Object.keys(shortOptionSpecs)]);

export function packageVersion(): string {
  const pkg = moduleRequire("../package.json") as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

function validateCommandFlags(command: string, flags: Record<string, string | boolean>): void {
  if (!isKnownCommand(command)) {
    throw new ClawpatchError(`unknown command: ${command}`, 2, "invalid-usage");
  }
  const allowed = new Set(commandSpecs[command].flags);
  for (const flag of Object.keys(flags)) {
    if (!allowed.has(flag)) {
      throw new ClawpatchError(
        `unsupported flag for ${command}: --${kebab(flag)}`,
        2,
        "invalid-usage",
      );
    }
  }
}

function validateCommandRequirements(
  command: string,
  flags: Record<string, string | boolean>,
): void {
  if (!isKnownCommand(command)) {
    throw new ClawpatchError(`unknown command: ${command}`, 2, "invalid-usage");
  }
  const spec: CommandSpec = commandSpecs[command];
  const required = spec.required ?? [];
  for (const flag of required) {
    if (typeof flags[flag] !== "string" || flags[flag].length === 0) {
      throw new ClawpatchError(`missing --${kebab(flag)}`, 2, "invalid-usage");
    }
  }
  spec.validate?.(flags);
}

function validateRevalidateFlags(flags: Flags): void {
  if (
    typeof flags["finding"] !== "string" &&
    flags["all"] !== true &&
    typeof flags["since"] !== "string" &&
    flags["includeDirty"] !== true
  ) {
    throw new ClawpatchError("missing --finding or --all", 2, "invalid-usage");
  }
}

function validateReviewFlags(flags: Flags): void {
  if (
    typeof flags["mode"] === "string" &&
    flags["mode"] !== "default" &&
    flags["mode"] !== "deslopify"
  ) {
    throw new ClawpatchError("invalid --mode; expected default or deslopify", 2, "invalid-usage");
  }
  if (typeof flags["featureList"] === "string") {
    for (const conflictingFlag of ["feature", "project", "since"] as const) {
      if (typeof flags[conflictingFlag] === "string") {
        throw new ClawpatchError(
          `--feature-list cannot be combined with --${kebab(conflictingFlag)}`,
          2,
          "invalid-usage",
        );
      }
    }
    if (flags["includeDirty"] === true) {
      throw new ClawpatchError(
        "--feature-list cannot be combined with --include-dirty",
        2,
        "invalid-usage",
      );
    }
  }
}

function isKnownCommand(command: string): command is keyof typeof commandSpecs {
  return Object.hasOwn(commandSpecs, command);
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || isKnownOptionToken(next)) {
    throw new ClawpatchError(`missing value for ${flag}`, 2, "invalid-usage");
  }
  return next;
}

function isKnownOptionToken(value: string): boolean {
  if (shortFlagNames.has(value)) {
    return true;
  }
  return value.startsWith("--");
}

function setOption(
  global: GlobalOptions,
  flags: Record<string, string | boolean>,
  option: OptionSpec,
  value: string | boolean,
): void {
  if (option.target === "global") {
    const target = global as Record<string, string | boolean | undefined>;
    target[option.name] = value;
    return;
  }
  flags[option.name] = value;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function writeResult(result: unknown, options: GlobalOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (
    typeof result === "object" &&
    result !== null &&
    "markdown" in result &&
    typeof result.markdown === "string" &&
    !options.plain
  ) {
    process.stdout.write(result.markdown);
    return;
  }
  if (typeof result === "object" && result !== null) {
    for (const [key, value] of Object.entries(result)) {
      if (key === "project" && typeof value === "object") {
        continue;
      }
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        process.stdout.write(`${key}: ${String(value)}\n`);
      }
    }
    return;
  }
  process.stdout.write(`${String(result)}\n`);
}

export function helpText(command = ""): string {
  if (isKnownCommand(command)) {
    const spec: CommandSpec = commandSpecs[command];
    const flagLines = [
      ...spec.flags.map((flag) => spec.helpOverrides?.[flag] ?? optionHelp(flag)),
      ...(spec.globalHelp ?? ["json"]).map(optionHelp),
    ];
    return [
      `clawpatch ${command}`,
      "",
      "Usage:",
      ...spec.usage.map((usage) => `  ${usage}`),
      "",
      "Flags:",
      ...flagLines,
      "",
    ].join("\n");
  }
  const globalFlags = [
    "root",
    "stateDir",
    "config",
    "json",
    "plain",
    "quiet",
    "verbose",
    "debug",
    "noColor",
    "noInput",
  ].map(optionHelp);
  return [
    "clawpatch: automated code review that lands fixes",
    "",
    "Usage:",
    "  clawpatch [global flags] <command> [flags]",
    "",
    "Commands:",
    ...Object.keys(commandSpecs).map((name) => `  ${name}`),
    "",
    "Global flags:",
    ...globalFlags,
    "  -h, --help",
    "  --version",
    "",
  ].join("\n");
}

function optionHelp(name: string): string {
  const option = optionSpecsByName.get(name);
  if (option === undefined) {
    throw new Error(`missing CLI option metadata: ${name}`);
  }
  return option.help;
}

function printHelp(command = ""): void {
  process.stdout.write(helpText(command));
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof ClawpatchError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}
