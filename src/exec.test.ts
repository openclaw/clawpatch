import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand, runCommandArgs } from "./exec.js";

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
      `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
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
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;

    const trimmed = await runCommand(command, dir);
    const raw = await runCommand(command, dir, undefined, { trimOutput: false });

    expect(trimmed.stdout).toContain("...[trimmed]...");
    expect(raw.stdout).toHaveLength(9000);
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
          `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'alive'), 2500);`,
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
        timeoutMs: 1000,
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
