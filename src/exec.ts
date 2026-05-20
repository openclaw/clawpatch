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
  const result = await runCommandRaw(command, cwd, input);
  return {
    ...result,
    stdout: options.trimOutput === false ? result.stdout : trimOutput(result.stdout),
    stderr: options.trimOutput === false ? result.stderr : trimOutput(result.stderr),
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
  let spawnErrorMessage: string | null = null;
  const exitCodePromise = new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(code);
    };
    child.on("error", (error: Error) => {
      spawnErrorMessage = error.message;
      finish(127);
    });
    child.on("close", finish);
  });
  endChildStdin(child, input);
  const exitCode = await exitCodePromise;
  if (spawnErrorMessage !== null) {
    stderr += stderr.length === 0 ? spawnErrorMessage : `\n${spawnErrorMessage}`;
  }
  return {
    command,
    cwd,
    exitCode,
    durationMs: Date.now() - started,
    stdout,
    stderr,
  };
}

export async function runCommandArgs(
  program: string,
  args: string[],
  cwd: string,
  input?: string,
  options: {
    trimOutput?: boolean;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    replaceEnv?: boolean;
  } = {},
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
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let forceKill: NodeJS.Timeout | undefined;
  let finishCommand: ((code: number | null) => void) | undefined;
  let removeAbortHandlers = noop;
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
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      removeAbortHandlers();
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
    removeAbortHandlers = installAbortHandlers(child);
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
    stderr += stderr.length === 0 ? spawnErrorMessage : `\n${spawnErrorMessage}`;
  }
  if (timedOut) {
    const message = `command timed out after ${options.timeoutMs}ms`;
    stderr += stderr.length === 0 ? message : `\n${message}`;
  }
  return {
    command: [program, ...args].map((arg) => JSON.stringify(arg)).join(" "),
    cwd,
    exitCode: timedOut ? 124 : exitCode,
    durationMs: Date.now() - started,
    stdout: options.trimOutput === false ? stdout : trimOutput(stdout),
    stderr: options.trimOutput === false ? stderr : trimOutput(stderr),
  };
}

function terminateChild(child: ReturnType<typeof spawn>, onForceKill: () => void): NodeJS.Timeout {
  void killChild(child, "SIGTERM");
  const force = setTimeout(() => {
    void killChild(child, "SIGKILL").finally(onForceKill);
  }, 500);
  return force;
}

async function killChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): Promise<void> {
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

function installAbortHandlers(child: ReturnType<typeof spawn>): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => {
      for (const [registeredSignal, registeredHandler] of handlers) {
        process.removeListener(registeredSignal, registeredHandler);
      }
      void killChild(child, "SIGKILL").finally(() => {
        process.exit(signalExitCode(signal));
      });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
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

function endChildStdin(child: ReturnType<typeof spawn>, input: string | undefined): void {
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

function trimOutput(value: string): string {
  if (value.length <= 8_000) {
    return value;
  }
  return `${value.slice(0, 4_000)}\n...[trimmed]...\n${value.slice(-4_000)}`;
}
