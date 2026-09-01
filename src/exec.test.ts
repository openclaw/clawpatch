import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, runCommandArgs, taskkillTimeoutMs, taskkillTree } from "./exec.js";
import { shellQuotePath } from "./shell.js";

describe("runCommand", () => {
  it("runs a shell command and passes stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-shell-"));
    const script = join(dir, "stdin.mjs");
    await writeFile(
      script,
      "process.stdin.setEncoding('utf8'); let input = ''; process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', () => process.stdout.write(input.toUpperCase()));",
      "utf8",
    );

    const result = await runCommand(
      `${shellQuotePath(process.execPath)} ${shellQuotePath(script)}`,
      dir,
      "ok",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
  });

  it("trims large output by default and can preserve raw output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-shell-"));
    const script = join(dir, "large-output.mjs");
    await writeFile(script, "process.stdout.write('x'.repeat(9000));", "utf8");
    const command = `${shellQuotePath(process.execPath)} ${shellQuotePath(script)}`;

    const trimmed = await runCommand(command, dir);
    const raw = await runCommand(command, dir, undefined, { trimOutput: false });

    expect(trimmed.stdout).toContain("...[trimmed]...");
    expect(raw.stdout).toHaveLength(9000);
  });

  it("applies timeout and streaming output bounds to shell commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-shell-limit-"));
    const noisy = join(dir, "noisy.mjs");
    const hanging = join(dir, "hanging.mjs");
    await writeFile(noisy, "process.stdout.write('x'.repeat(1000000));", "utf8");
    await writeFile(hanging, "setInterval(() => {}, 1000);", "utf8");

    const bounded = await runCommand(
      `${shellQuotePath(process.execPath)} ${shellQuotePath(noisy)}`,
      dir,
      undefined,
      { trimOutput: false, maxOutputChars: 10_000 },
    );
    const timedOut = await runCommand(
      `${shellQuotePath(process.execPath)} ${shellQuotePath(hanging)}`,
      dir,
      undefined,
      { timeoutMs: 50 },
    );

    expect(bounded.stdout.length).toBeLessThan(10_100);
    expect(bounded.stdout).toContain("...[output truncated]...");
    expect(timedOut.exitCode).toBe(124);
    expect(timedOut.stderr).toContain("command timed out after 50ms");
  });
});

describe("runCommandArgs", () => {
  it("passes paths with spaces and quotes without shell quoting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-"));
    const script = join(dir, "print-args.mjs");
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");

    const args = [
      script,
      "--cd",
      "C:\\Users\\test user\\repo",
      "--output-last-message",
      'C:\\Temp\\schema "quoted" & safe.json',
    ];
    const result = await runCommandArgs(process.execPath, args, dir);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args.slice(1));
  });

  it("returns a command result when the executable is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-"));
    const result = await runCommandArgs("clawpatch-missing-executable-for-test", [], dir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("clawpatch-missing-executable-for-test");
  });

  it("does not surface EPIPE when a child exits before reading stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-stdin-"));
    const input = "x".repeat(1_000_000);
    const result = await runCommandArgs(process.execPath, ["-e", "process.exit(0)"], dir, input);

    expect(result.exitCode).toBe(0);
  });

  it("terminates commands that exceed a timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-timeout-"));
    const script = join(dir, "hang.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n", "utf8");

    const result = await runCommandArgs(process.execPath, [script], dir, undefined, {
      timeoutMs: 50,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("command timed out after 50ms");
  });

  it("shares and removes process abort handlers across concurrent commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-timeout-"));
    const script = join(dir, "hang.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n", "utf8");
    const baseline = new Map(
      (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [
        signal,
        process.listenerCount(signal),
      ]),
    );

    const commands = Array.from({ length: 12 }, () =>
      runCommandArgs(process.execPath, [script], dir, undefined, { timeoutMs: 1000 }),
    );

    for (const [signal, count] of baseline) {
      expect(process.listenerCount(signal)).toBe(count + 1);
    }
    const results = await Promise.all(commands);
    expect(results.every((result) => result.exitCode === 124)).toBe(true);
    for (const [signal, count] of baseline) {
      expect(process.listenerCount(signal)).toBe(count);
    }
  });

  it("returns after timeout even when descendants inherit stdio", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-timeout-"));
    const childScript = join(dir, "child.mjs");
    const parentScript = join(dir, "parent.mjs");
    await writeFile(childScript, "setInterval(() => {}, 1000);\n", "utf8");
    await writeFile(
      parentScript,
      [
        "import { spawn } from 'node:child_process';",
        `spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const started = Date.now();
    const result = await runCommandArgs(process.execPath, [parentScript], dir, undefined, {
      timeoutMs: 50,
    });

    expect(result.exitCode).toBe(124);
    expect(result.durationMs).toBeLessThan(1500);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.stderr).toContain("command timed out after 50ms");
  });

  it.runIf(process.platform !== "win32")(
    "force-kills timed-out descendants that ignore SIGTERM",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-timeout-"));
      const marker = join(dir, "still-alive");
      const ready = join(dir, "ready");
      const childScript = join(dir, "child.mjs");
      const parentScript = join(dir, "parent.mjs");
      await writeFile(
        childScript,
        [
          "import { writeFileSync } from 'node:fs';",
          "process.on('SIGTERM', () => {});",
          "process.send?.('ready');",
          `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'alive'), 4500);`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        parentScript,
        [
          "import { writeFileSync } from 'node:fs';",
          "import { spawn } from 'node:child_process';",
          `const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });`,
          "child.on('error', () => {});",
          `child.on('message', (message) => { if (message === 'ready') writeFileSync(${JSON.stringify(ready)}, 'ready'); });`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );

      const result = await runCommandArgs(process.execPath, [parentScript], dir, undefined, {
        timeoutMs: 3000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(result.exitCode).toBe(124);
      await expect(access(ready)).resolves.toBeUndefined();
      await expect(access(marker)).rejects.toThrow();
    },
  );

  it.runIf(process.platform === "win32")("runs cmd shims with escaped arguments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawpatch-exec-"));
    const script = join(dir, "print-args.mjs");
    const shim = join(dir, "codex.cmd");
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");

    const args = ["--cd", "C:\\Users\\test user\\repo", "--model", 'name "quoted" & safe'];
    const result = await runCommandArgs(shim, args, dir);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const cleanupTimeoutMs = 1_000;

describe("taskkillTree", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(spawn).mockImplementation(childProcess.spawn);
  });

  it("defaults to 5s and accepts supported millisecond overrides", () => {
    vi.stubEnv("CLAWPATCH_TASKKILL_TIMEOUT_MS", undefined);
    expect(taskkillTimeoutMs()).toBe(5_000);
    vi.stubEnv("CLAWPATCH_TASKKILL_TIMEOUT_MS", "1234");
    expect(taskkillTimeoutMs()).toBe(1_234);
    vi.stubEnv("CLAWPATCH_TASKKILL_TIMEOUT_MS", "2147483647");
    expect(taskkillTimeoutMs()).toBe(2_147_483_647);
  });

  it.each(["invalid", "", "0", "-1", "0.5", "Infinity", "2147483648"])(
    "rejects unsupported timeout override %s",
    (value) => {
      vi.stubEnv("CLAWPATCH_TASKKILL_TIMEOUT_MS", value);
      expect(taskkillTimeoutMs()).toBe(5_000);
    },
  );

  it("bounds a verified hanging cleanup process", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawpatch-taskkill-"));
    const marker = join(root, "killer.json");
    const children = interceptTaskkill(marker);
    try {
      await taskkillTree(42_424, cleanupTimeoutMs);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual(["/pid", "42424", "/T", "/F"]);
      expect(children).toHaveLength(1);
      await expect
        .poll(() => children[0]?.exitCode !== null || children[0]?.signalCode !== null)
        .toBe(true);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "returns a timeout and kills the original child when taskkill hangs",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "clawpatch-taskkill-caller-"));
      const marker = join(root, "killer.json");
      const children = interceptTaskkill(marker);
      vi.stubEnv("CLAWPATCH_TASKKILL_TIMEOUT_MS", String(cleanupTimeoutMs));
      let pid: number | undefined;
      try {
        const result = await runCommandArgs(
          process.execPath,
          ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
          root,
          undefined,
          { timeoutMs: 1_000 },
        );
        pid = Number(result.stdout.trim());
        expect(pid).toBeGreaterThan(0);
        expect(result.exitCode).toBe(124);
        expect(result.stderr).toContain("command timed out after 1000ms");
        expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([
          "/pid",
          String(pid),
          "/T",
          "/F",
        ]);
        expect(children.length).toBeGreaterThan(0);
        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        for (const child of children) child.kill("SIGKILL");
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

function interceptTaskkill(marker: string): ChildProcess[] {
  const realSpawn = childProcess.spawn;
  const children: ChildProcess[] = [];
  vi.mocked(spawn).mockImplementation(((...params: Parameters<typeof spawn>) => {
    const [program, args = [], options = {}] = params;
    if (program !== "taskkill") return realSpawn(program, args, options);
    const child = realSpawn(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))); setInterval(() => {}, 1000)",
        marker,
        ...args,
      ],
      options,
    );
    children.push(child);
    return child;
  }) as typeof childProcess.spawn);
  return children;
}
