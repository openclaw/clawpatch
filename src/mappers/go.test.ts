import { chmod } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureRoot, writeFixture } from "../test-helpers.js";
import { goListTimeoutMs, goSeeds, runGoList } from "./go.js";
import { emptyTaskGraph } from "./task-graph.js";
import type { MapperContext } from "./types.js";

const HANG_TEST_TIMEOUT_MS = 4_000;
const SHORT_TIMEOUT_MS = 80;

describe("go list timeout", () => {
  const previousEnv = {
    CLAWPATCH_GO_LIST_TIMEOUT_MS: process.env["CLAWPATCH_GO_LIST_TIMEOUT_MS"],
    PATH: process.env["PATH"],
  };

  afterEach(() => {
    restoreEnv("CLAWPATCH_GO_LIST_TIMEOUT_MS", previousEnv.CLAWPATCH_GO_LIST_TIMEOUT_MS);
    restoreEnv("PATH", previousEnv.PATH);
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
      expect(Date.now() - started).toBeLessThan(1_500);
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

      expect(Date.now() - started).toBeLessThan(1_500);
      expect(seeds.map((seed) => seed.title)).toContain("Go package store");
    },
  );
});

async function writeHangGo(root: string): Promise<string> {
  const binDir = join(root, "bin");
  if (process.platform === "win32") {
    await writeFixture(
      root,
      "bin/go.cmd",
      "@echo off\r\n:loop\r\ntimeout /t 30 >nul\r\ngoto loop\r\n",
    );
    return binDir;
  }
  const wrapper = join(binDir, "go");
  await writeFixture(root, "bin/go", "#!/bin/sh\nwhile true; do sleep 30; done\n");
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
