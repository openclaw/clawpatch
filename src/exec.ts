import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { CommandResult } from "./types.js";

type SpawnedChild = ReturnType<typeof spawn>;
type CommandOptions = {
  trimOutput?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  replaceEnv?: boolean;
  maxOutputChars?: number;
};

const abortSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const abortableChildren = new Set<SpawnedChild>();
const abortHandlers = new Map<NodeJS.Signals, () => void>();

export async function runCommand(
  command: string,
  cwd: string,
  input?: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  return runCommandRaw(command, cwd, input, options);
}

export async function runCommandRaw(
  command: string,
  cwd: string,
  input?: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const shell = process.platform === "win32" ? (process.env["ComSpec"] ?? "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const result = await runCommandArgs(shell, args, cwd, input, options);
  return { ...result, command };
}

export async function runCommandArgs(
  program: string,
  args: string[],
  cwd: string,
  input?: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const started = Date.now();
  const spawnSpec = commandSpawnSpec(program, args);
  const child = spawn(spawnSpec.program, spawnSpec.args, {
    cwd,
    env:
      options.env === undefined
        ? process.env
        : options.replaceEnv === true
          ? options.env
          : { ...process.env, ...options.env },
    detached: process.platform !== "win32" && options.timeoutMs !== undefined,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
  });
  const stdout = new OutputBuffer(options.maxOutputChars);
  const stderr = new OutputBuffer(options.maxOutputChars);
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let forceKill: NodeJS.Timeout | undefined;
  let finishCommand: ((code: number | null) => void) | undefined;
  let unregisterAbortableChild = noop;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout.append(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr.append(chunk);
  });
  let spawnErrorMessage: string | null = null;
  const exitCodePromise = new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      unregisterAbortableChild();
      resolve(code);
    };
    finishCommand = finish;
    child.on("error", (error: Error) => {
      spawnErrorMessage = error.message;
      finish(127);
    });
    child.on("close", (code) => {
      if (forceKill !== undefined && !timedOut) {
        clearTimeout(forceKill);
      }
      if (timedOut && forceKill !== undefined) {
        return;
      }
      finish(code);
    });
  });
  if (options.timeoutMs !== undefined) {
    unregisterAbortableChild = registerAbortableChild(child);
    timeout = setTimeout(() => {
      timedOut = true;
      forceKill = terminateChild(child, () => {
        child.stdout.destroy();
        child.stderr.destroy();
        finishCommand?.(124);
      });
    }, options.timeoutMs);
  }
  endChildStdin(child, input);
  const exitCode = await exitCodePromise;
  if (spawnErrorMessage !== null) {
    stderr.append(`${stderr.isEmpty ? "" : "\n"}${spawnErrorMessage}`);
  }
  if (timedOut) {
    const message = `command timed out after ${options.timeoutMs}ms`;
    stderr.append(`${stderr.isEmpty ? "" : "\n"}${message}`);
  }
  return {
    command: [program, ...args].map((arg) => JSON.stringify(arg)).join(" "),
    cwd,
    exitCode: timedOut ? 124 : exitCode,
    durationMs: Date.now() - started,
    stdout: options.trimOutput === false ? stdout.value : trimOutput(stdout.value),
    stderr: options.trimOutput === false ? stderr.value : trimOutput(stderr.value),
  };
}

function terminateChild(child: SpawnedChild, onForceKill: () => void): NodeJS.Timeout {
  void killChild(child, "SIGTERM");
  const force = setTimeout(() => {
    void killChild(child, "SIGKILL").finally(onForceKill);
  }, 500);
  return force;
}

async function killChild(child: SpawnedChild, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === "win32" && child.pid !== undefined) {
    await taskkillTree(child.pid);
    return;
  }
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {}
  try {
    child.kill(signal);
  } catch {}
}

async function taskkillTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => resolve());
    killer.on("close", () => resolve());
  });
}

function registerAbortableChild(child: SpawnedChild): () => void {
  abortableChildren.add(child);
  installAbortHandlers();
  let registered = true;
  return () => {
    if (!registered) {
      return;
    }
    registered = false;
    abortableChildren.delete(child);
    if (abortableChildren.size === 0) {
      removeAbortHandlers();
    }
  };
}

function installAbortHandlers(): void {
  if (abortHandlers.size > 0) {
    return;
  }
  for (const signal of abortSignals) {
    const handler = (): void => abortAllChildren(signal);
    abortHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function removeAbortHandlers(): void {
  for (const [signal, handler] of abortHandlers) {
    process.removeListener(signal, handler);
  }
  abortHandlers.clear();
}

function abortAllChildren(signal: NodeJS.Signals): void {
  const children = [...abortableChildren];
  abortableChildren.clear();
  removeAbortHandlers();
  void Promise.all(children.map((child) => killChild(child, "SIGKILL"))).finally(() => {
    process.exit(signalExitCode(signal));
  });
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 129;
}

function noop(): void {}

function endChildStdin(child: SpawnedChild, input: string | undefined): void {
  const stdin = child.stdin;
  if (stdin === null) {
    return;
  }
  stdin.on("error", noop);
  if (input !== undefined) {
    stdin.end(input);
  } else {
    stdin.end();
  }
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

class OutputBuffer {
  private head = "";
  private tail = "";
  private total = 0;

  public constructor(private readonly limit: number | undefined) {}

  public append(chunk: string): void {
    this.total += chunk.length;
    if (this.limit === undefined) {
      this.head += chunk;
      return;
    }
    const half = Math.max(1, Math.floor(this.limit / 2));
    if (this.head.length < half) {
      const remaining = half - this.head.length;
      this.head += chunk.slice(0, remaining);
      chunk = chunk.slice(remaining);
    }
    if (chunk.length > 0) {
      this.tail = `${this.tail}${chunk}`.slice(-half);
    }
  }

  public get isEmpty(): boolean {
    return this.total === 0;
  }

  public get value(): string {
    if (this.limit === undefined || this.total <= this.limit) {
      return this.head + this.tail;
    }
    return `${this.head}\n...[output truncated]...\n${this.tail}`;
  }
}

function trimOutput(value: string): string {
  if (value.length <= 8_000) {
    return value;
  }
  return `${value.slice(0, 4_000)}\n...[trimmed]...\n${value.slice(-4_000)}`;
}
