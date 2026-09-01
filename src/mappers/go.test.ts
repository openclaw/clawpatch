import { chmod, readFile, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shellQuotePath } from "../shell.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";
import { goListTimeoutMs, goSeeds, runGoList } from "./go.js";
import { emptyTaskGraph } from "./task-graph.js";
import type { MapperContext } from "./types.js";

const HANG_TEST_TIMEOUT_MS = 10_000;
const SHORT_TIMEOUT_MS = 3_000;
const roots: string[] = [];

describe("go list timeout", () => {
  const previousEnv = {
    CLAWPATCH_GO_LIST_TIMEOUT_MS: process.env["CLAWPATCH_GO_LIST_TIMEOUT_MS"],
    PATH: process.env["PATH"],
  };

  afterEach(async () => {
    restoreEnv("CLAWPATCH_GO_LIST_TIMEOUT_MS", previousEnv.CLAWPATCH_GO_LIST_TIMEOUT_MS);
    restoreEnv("PATH", previousEnv.PATH);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("defaults go list to 2m and rejects invalid overrides", () => {
    delete process.env["CLAWPATCH_GO_LIST_TIMEOUT_MS"];
    expect(goListTimeoutMs()).toBe(120_000);

    process.env["CLAWPATCH_GO_LIST_TIMEOUT_MS"] = "1234";
    expect(goListTimeoutMs()).toBe(1_234);

    process.env["CLAWPATCH_GO_LIST_TIMEOUT_MS"] = "invalid";
    expect(goListTimeoutMs()).toBe(120_000);

    process.env["CLAWPATCH_GO_LIST_TIMEOUT_MS"] = "0";
    expect(goListTimeoutMs()).toBe(120_000);
  });

  it.each(["-1", "0.5", "Infinity", "2147483648"])("rejects unsupported override %s", (value) => {
    process.env["CLAWPATCH_GO_LIST_TIMEOUT_MS"] = value;
    expect(goListTimeoutMs()).toBe(120_000);
  });

  it("accepts the maximum supported timer delay", () => {
    process.env["CLAWPATCH_GO_LIST_TIMEOUT_MS"] = "2147483647";
    expect(goListTimeoutMs()).toBe(2_147_483_647);
  });

  it(
    "times out a hung go list instead of blocking the mapper",
    { timeout: HANG_TEST_TIMEOUT_MS },
    async () => {
      const root = await fixtureRoot("clawpatch-go-list-timeout-");
      await writeFixture(root, "go.mod", "module example.com/hang\n\ngo 1.26\n");
      process.env["PATH"] = `${await writeHangGo(root)}${delimiter}${process.env["PATH"] ?? ""}`;

      const started = Date.now();
      const stdout = await runGoList(root, SHORT_TIMEOUT_MS);

      expect(stdout).toBe("");
      expect(JSON.parse(await readFile(join(root, "go-invoked.json"), "utf8"))).toEqual([
        "list",
        "-e",
        "-f",
        "{{.Dir}}|{{.ImportPath}}|{{.Name}}",
        "./...",
      ]);
      expect(Date.now() - started).toBeLessThan(7_000);
    },
  );

  it(
    "falls back to file mapping when go list times out",
    { timeout: HANG_TEST_TIMEOUT_MS },
    async () => {
      const root = await fixtureRoot("clawpatch-go-list-timeout-fallback-");
      await writeFixture(root, "go.mod", "module example.com/hang\n\ngo 1.26\n");
      await writeFixture(root, "internal/store/chats.go", "package store\n");
      process.env["PATH"] = `${await writeHangGo(root)}${delimiter}${process.env["PATH"] ?? ""}`;
      process.env["CLAWPATCH_GO_LIST_TIMEOUT_MS"] = String(SHORT_TIMEOUT_MS);

      const started = Date.now();
      const seeds = await goSeeds(root, mapperContext(["internal/store/chats.go"]));

      expect(Date.now() - started).toBeLessThan(7_000);
      expect(seeds.map((seed) => seed.title)).toContain("Go package store");
      expect(await readFile(join(root, "go-invoked.json"), "utf8")).toContain("list");
    },
  );
});

async function writeHangGo(root: string): Promise<string> {
  roots.push(root);
  const binDir = join(root, "bin");
  const script = join(binDir, "go.cjs");
  await writeFixture(
    root,
    "bin/go.cjs",
    [
      `require('node:fs').writeFileSync(${JSON.stringify(join(root, "go-invoked.json"))}, JSON.stringify(process.argv.slice(2)));`,
      `console.log(${JSON.stringify(`${root}|example.com/hang|main`)});`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    await writeFixture(root, "bin/go.cmd", `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return binDir;
  }
  const wrapper = join(binDir, "go");
  await writeFixture(
    root,
    "bin/go",
    `#!/bin/sh\nexec ${shellQuotePath(process.execPath)} ${shellQuotePath(script)} "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  return binDir;
}

function mapperContext(files: string[]): MapperContext {
  return {
    nodeProjects: async () => [],
    nodeTaskGraph: async () => emptyTaskGraph(),
    rootFiles: async () => files,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
