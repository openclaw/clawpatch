import { mkdtemp, writeFile } from "node:fs/promises";
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
