import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommandArgs } from "./exec.js";

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
          `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'alive'), 1000);`,
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
        timeoutMs: 300,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));

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
