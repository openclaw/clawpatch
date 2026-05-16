import { spawn } from "node:child_process";
import { CommandResult } from "./types.js";

export async function runCommand(
  command: string,
  cwd: string,
  input?: string,
): Promise<CommandResult> {
  const result = await runCommandRaw(command, cwd, input);
  return {
    ...result,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

export async function runCommandRaw(
  command: string,
  cwd: string,
  input?: string,
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
  if (input !== undefined) {
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  return {
    command,
    cwd,
    exitCode,
    durationMs: Date.now() - started,
    stdout,
    stderr,
  };
}

function trimOutput(value: string): string {
  if (value.length <= 8_000) {
    return value;
  }
  return `${value.slice(0, 4_000)}\n...[trimmed]...\n${value.slice(-4_000)}`;
}
