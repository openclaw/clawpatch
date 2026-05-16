import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { CommandResult } from "./types.js";

export async function runCommand(
  command: string,
  cwd: string,
  input?: string,
  options: { trimOutput?: boolean } = {},
): Promise<CommandResult> {
  const started = Date.now();
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let spawnErrorMessage: string | null = null;
  const exitCodePromise = new Promise<number | null>((resolve) => {
    child.on("error", (error: Error) => {
      spawnErrorMessage = error.message;
      resolve(127);
    });
    child.on("close", resolve);
  });
  if (input !== undefined) {
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }
  const exitCode = await exitCodePromise;
  if (spawnErrorMessage !== null) {
    stderr += stderr.length === 0 ? spawnErrorMessage : `\n${spawnErrorMessage}`;
  }
  return {
    command,
    cwd,
    exitCode,
    durationMs: Date.now() - started,
    stdout: options.trimOutput === false ? stdout : trimOutput(stdout),
    stderr: options.trimOutput === false ? stderr : trimOutput(stderr),
  };
}

export async function runCommandArgs(
  program: string,
  args: string[],
  cwd: string,
  input?: string,
  options: { trimOutput?: boolean } = {},
): Promise<CommandResult> {
  const started = Date.now();
  const spawnSpec = commandSpawnSpec(program, args);
  const child = spawn(spawnSpec.program, spawnSpec.args, {
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let spawnErrorMessage: string | null = null;
  const exitCodePromise = new Promise<number | null>((resolve) => {
    child.on("error", (error: Error) => {
      spawnErrorMessage = error.message;
      resolve(127);
    });
    child.on("close", resolve);
  });
  if (input !== undefined) {
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }
  const exitCode = await exitCodePromise;
  if (spawnErrorMessage !== null) {
    stderr += stderr.length === 0 ? spawnErrorMessage : `\n${spawnErrorMessage}`;
  }
  return {
    command: [program, ...args].map((arg) => JSON.stringify(arg)).join(" "),
    cwd,
    exitCode,
    durationMs: Date.now() - started,
    stdout: options.trimOutput === false ? stdout : trimOutput(stdout),
    stderr: options.trimOutput === false ? stderr : trimOutput(stderr),
  };
}

function commandSpawnSpec(
  program: string,
  args: string[],
): { program: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (process.platform !== "win32") {
    return { program, args, windowsVerbatimArguments: false };
  }
  const resolved = resolveWindowsProgram(program) ?? program;
  if (!/\.(?:cmd|bat)$/iu.test(resolved)) {
    return { program: resolved, args, windowsVerbatimArguments: false };
  }
  return {
    program: process.env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", [resolved, ...args].map(escapeCmdArgument).join(" ")],
    windowsVerbatimArguments: true,
  };
}

function resolveWindowsProgram(program: string): string | null {
  if (program.includes("\\") || program.includes("/") || extname(program) !== "") {
    return program;
  }
  const path = process.env["PATH"] ?? "";
  const extensions = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.length > 0);
  for (const directory of path.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${program}${extension.toLowerCase()}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function escapeCmdArgument(value: string): string {
  const escaped = value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, "$1$1");
  return `"${escaped}"`.replace(/([()%!^"<>&|])/gu, "^$1");
}

function trimOutput(value: string): string {
  if (value.length <= 8_000) {
    return value;
  }
  return `${value.slice(0, 4_000)}\n...[trimmed]...\n${value.slice(-4_000)}`;
}
